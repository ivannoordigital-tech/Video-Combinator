import fs from "node:fs";
import path from "node:path";
import { AssetsRegistry, AssetItem, AssetKind } from "../schemas/assets.js";
import { Manifest, OutputItem } from "../schemas/manifest.js";
import { ProductConfig, computeSpecHash, computeMusicConfigHash } from "../schemas/product.js";
import { JobScope } from "../schemas/job.js";
import { NamingUtils } from "./naming.js";
import { OutputVerifier, VerificationResult, MIN_OUTPUT_BYTES, isMp4StructurallyIntact } from "./verify.js";

export interface PlanCombination {
  key: string;
  filename: string;
  hookFile: string;
  bodyFile: string;
  ctaFile: string;
  hookItem: AssetItem;
  bodyItem: AssetItem;
  ctaItem: AssetItem;
  status: "QUEUED" | "SKIPPED" | "STALE" | "ORPHAN";
  reason?: string;
  /** Backsound yang dipilih untuk output ini (null jika musik nonaktif/kosong). */
  musicFile?: string | null;
  musicItem?: AssetItem | null;
}

export interface PlanResult {
  counts: {
    hooks: number;
    bodies: number;
    ctas: number;
    music: number;
    total: number;
    done: number;
    stale: number;
    orphan: number;
    queued: number;
  };
  scope: JobScope;
  queue: PlanCombination[];
  estimate: {
    avgOutputMb: number;
    requiredMb: number;
    freeMb: number;
    etaSeconds: number;
  };
  blockers: string[];
  warnings: string[];
}

/**
 * Cache hasil verifikasi in-memory. Kunci = path + mtimeMs + sizeBytes sehingga
 * ffprobe tidak dipanggil berulang untuk file yang sama selama plan berikutnya.
 */
const verificationCache = new Map<string, Promise<VerificationResult>>();
const VERIFICATION_CACHE_LIMIT = 5000;

export function clearPlanVerificationCache(): void {
  verificationCache.clear();
}

/** Toleransi mtime file terhadap createdAt manifest untuk fast-path. */
const FAST_PATH_MTIME_SLACK_MS = 1000;

/**
 * Fast-path murah tanpa ffprobe untuk output yang sudah diverifikasi saat render
 * (`verified === true`) dan tidak berubah sejak dibuat:
 * - file ada & berupa file reguler,
 * - size >= 50 KB dan sama dengan sizeBytes manifest,
 * - mtime tidak lebih baru dari createdAt manifest (+1 detik),
 * - struktur box MP4 utuh (mendeteksi file ter-truncate/berisi nol),
 * - metadata manifest lengkap (durasi, size, specHash).
 * Jika salah satu syarat tidak terpenuhi, pemanggil wajib memakai verifyOutput penuh.
 */
function tryVerifiedFastPath(fullPath: string, out: OutputItem): VerificationResult | null {
  if (out.verified !== true) return null;
  if (!Number.isFinite(out.durationSeconds) || out.durationSeconds <= 0) return null;
  if (!Number.isFinite(out.sizeBytes) || out.sizeBytes <= 0) return null;
  if (typeof out.specHash !== "string" || out.specHash.length === 0) return null;

  const createdAtMs = Date.parse(out.createdAt);
  if (!Number.isFinite(createdAtMs)) return null;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(fullPath);
  } catch {
    return null;
  }

  if (!stats.isFile()) return null;
  if (stats.size < MIN_OUTPUT_BYTES) return null;
  // Ukuran berbeda dari catatan manifest -> file berubah, perlu verifikasi penuh.
  if (stats.size !== out.sizeBytes) return null;
  // File yang disentuh setelah render tidak dipercaya tanpa ffprobe.
  if (stats.mtimeMs > createdAtMs + FAST_PATH_MTIME_SLACK_MS) return null;
  if (!isMp4StructurallyIntact(fullPath, stats.size)) return null;

  return {
    valid: true,
    durationSeconds: out.durationSeconds,
    sizeBytes: stats.size,
    error: null,
  };
}

async function verifyCached(
  fullPath: string,
  expectedDuration: number,
  product: ProductConfig
): Promise<VerificationResult> {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(fullPath);
  } catch {
    return { valid: false, durationSeconds: 0, sizeBytes: 0, error: "File output tidak ditemukan" };
  }

  if (!stats.isFile()) {
    return { valid: false, durationSeconds: 0, sizeBytes: 0, error: "Path output bukan file reguler" };
  }

  // File terlalu kecil tidak perlu di-probe (dan tidak boleh dianggap DONE).
  if (stats.size < MIN_OUTPUT_BYTES) {
    return {
      valid: false,
      durationSeconds: 0,
      sizeBytes: stats.size,
      error: `Ukuran file terlalu kecil (< ${MIN_OUTPUT_BYTES / 1024} KB)`,
    };
  }

  const cacheKey = `${fullPath}|${stats.mtimeMs}|${stats.size}`;
  const cached = verificationCache.get(cacheKey);
  if (cached) return cached;

  const pending = OutputVerifier.verifyOutput(fullPath, expectedDuration, product);
  verificationCache.set(cacheKey, pending);

  if (verificationCache.size > VERIFICATION_CACHE_LIMIT) {
    // Buang entri tertua (Map menjaga urutan insert) agar memori tetap terbatas.
    let toDrop = Math.ceil(VERIFICATION_CACHE_LIMIT / 10);
    for (const key of verificationCache.keys()) {
      verificationCache.delete(key);
      if (--toDrop <= 0) break;
    }
  }

  return pending;
}

/** Menjalankan tugas async dengan batas paralel agar tidak membanjiri ffprobe. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

export class PlanEngine {
  public static async createPlan(
    productRoot: string,
    product: ProductConfig,
    registry: AssetsRegistry,
    manifest: Manifest,
    scope: JobScope = "new"
  ): Promise<PlanResult> {
    const specHash = computeSpecHash(product.video, product.audio);

    // Ambil aset yang aktif dan READY
    const hooks = Object.entries(registry.assets.hook)
      .filter(([_, item]) => item.enabled && item.status === "READY");
    const bodies = Object.entries(registry.assets.body)
      .filter(([_, item]) => item.enabled && item.status === "READY");
    const ctas = Object.entries(registry.assets.cta)
      .filter(([_, item]) => item.enabled && item.status === "READY");
    const musicTracks = Object.entries(registry.assets.music)
      .filter(([_, item]) => item.enabled && item.status === "READY");

    const musicFolder = path.join(productRoot, "database", product.slug, "backsounds");
    let hasMusicFiles = false;
    try {
      const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac"]);
      hasMusicFiles = fs
        .readdirSync(musicFolder)
        .some((file) => audioExtensions.has(path.extname(file).toLowerCase()));
    } catch {
      // Folder backsounds belum ada.
    }

    const musicAvailable = product.music.enabled && musicTracks.length > 0;
    const musicConfigHash = computeMusicConfigHash(product.music);

    const pickMusic = (
      key: string,
      index: number
    ): { file: string; item: AssetItem } | null => {
      if (!musicAvailable) return null;

      if (product.music.selection === "fixed") {
        const fixed = product.music.fixedFile
          ? musicTracks.find(([file]) => file === product.music.fixedFile)
          : undefined;
        const chosen = fixed ?? musicTracks[0]!;
        return { file: chosen[0], item: chosen[1] };
      }

      if (product.music.selection === "hash") {
        const parsed = Number.parseInt(key.slice(0, 8), 16);
        const chosen = musicTracks[(Number.isFinite(parsed) ? parsed : 0) % musicTracks.length]!;
        return { file: chosen[0], item: chosen[1] };
      }

      const chosen = musicTracks[index % musicTracks.length]!;
      return { file: chosen[0], item: chosen[1] };
    };

    const isMusicValidForOutput = (out: OutputItem): boolean => {
      if (!musicAvailable) return !out.music;
      if (!out.music || !out.musicFingerprint) return false;
      if (out.musicConfigHash !== musicConfigHash) return false;
      return musicTracks.some(
        ([file, item]) => file === out.music && item.sha256 === out.musicFingerprint
      );
    };

    const totalCombinations = hooks.length * bodies.length * ctas.length;
    const allCombinations: PlanCombination[] = [];

    // Lacak aset mana saja yang sudah pernah dipakai di output yang DONE
    const usedHooksInDone = new Set<string>();
    const usedBodiesInDone = new Set<string>();
    const usedCtasInDone = new Set<string>();

    for (const out of Object.values(manifest.outputs)) {
      if (out.status === "DONE") {
        usedHooksInDone.add(out.hook);
        usedBodiesInDone.add(out.body);
        usedCtasInDone.add(out.cta);
      }
    }

    const outputDir = path.join(productRoot, "output", product.slug);

    // Verifikasi semua entri DONE sekali di awal (hasil di-cache per mtime+size).
    const doneEntries = Object.entries(manifest.outputs).filter(([, out]) => out.status === "DONE");
    const verificationResults = new Map<string, VerificationResult>();

    const verifiedList = await mapWithConcurrency(doneEntries, 8, async ([filename, out]) => {
      const fullPath = path.join(outputDir, filename);

      // Jalur cepat: output verified yang file-nya tidak berubah sejak render.
      const fastResult = tryVerifiedFastPath(fullPath, out);
      if (fastResult) return [filename, fastResult] as const;

      const expectedDuration = this.resolveExpectedDuration(out, registry);
      const result = await verifyCached(fullPath, expectedDuration, product);
      return [filename, result] as const;
    });

    for (const [filename, result] of verifiedList) {
      verificationResults.set(filename, result);
    }

    // Filename kombinasi yang valid pada cartesian aset enabled+READY saat ini.
    const currentGridFilenames = new Set<string>();

    let doneCount = 0;
    let staleCount = 0;
    let invalidDoneCount = 0;

    for (const [hookFile, hookItem] of hooks) {
      for (const [bodyFile, bodyItem] of bodies) {
        for (const [ctaFile, ctaItem] of ctas) {
          const key = NamingUtils.computeHash8(product.slug, hookFile, bodyFile, ctaFile);
          const filename = NamingUtils.formatOutputFilename(
            product.slug,
            hookItem.slug,
            bodyItem.slug,
            ctaItem.slug,
            key
          );

          currentGridFilenames.add(filename);

          const existingOutput = manifest.outputs[filename];

          let comboStatus: "QUEUED" | "SKIPPED" | "STALE" | "ORPHAN" = "QUEUED";
          let reason = "";

          if (existingOutput && existingOutput.status === "DONE") {
            const sameFingerprints =
              existingOutput.assetFingerprints.hook === hookItem.sha256 &&
              existingOutput.assetFingerprints.body === bodyItem.sha256 &&
              existingOutput.assetFingerprints.cta === ctaItem.sha256;

            const sameSpec = existingOutput.specHash === specHash;
            const verification = verificationResults.get(filename);
            const verified = verification?.valid === true;

            if (!sameFingerprints || !sameSpec) {
              comboStatus = "STALE";
              staleCount++;
              reason = "Aset sumber atau konfigurasi produk telah diperbarui";
            } else if (!verified) {
              // Entri manifest mengaku DONE, tetapi file hilang/ter-truncate/gagal probe.
              comboStatus = "QUEUED";
              invalidDoneCount++;
              reason = `Verifikasi output DONE gagal: ${verification?.error || "tidak lolos verifikasi"}`;
            } else if (!isMusicValidForOutput(existingOutput)) {
              comboStatus = "STALE";
              staleCount++;
              reason = "Konfigurasi atau berkas backsound berubah";
            } else {
              comboStatus = "SKIPPED";
              doneCount++;
            }
          } else if (existingOutput && existingOutput.status === "FAILED") {
            comboStatus = "QUEUED";
            reason = `Render sebelumnya gagal: ${existingOutput.error || "tanpa detail"}`;
          }

          allCombinations.push({
            key,
            filename,
            hookFile,
            bodyFile,
            ctaFile,
            hookItem,
            bodyItem,
            ctaItem,
            status: comboStatus,
            reason,
          });
        }
      }
    }

    // Hitung orphan: output DONE yang kombinasinya tidak ada lagi di cartesian aktif,
    // atau asetnya sudah tidak terdaftar di registry aktif.
    let orphanCount = 0;
    const registryFilenames: Record<AssetKind, Set<string>> = {
      hook: new Set(Object.keys(registry.assets.hook)),
      body: new Set(Object.keys(registry.assets.body)),
      cta: new Set(Object.keys(registry.assets.cta)),
      music: new Set(Object.keys(registry.assets.music)),
    };

    for (const [filename, out] of Object.entries(manifest.outputs)) {
      if (out.status !== "DONE") continue;

      const inCurrentGrid = currentGridFilenames.has(filename);
      const assetsRegistered =
        registryFilenames.hook.has(out.hook) &&
        registryFilenames.body.has(out.body) &&
        registryFilenames.cta.has(out.cta);

      if (!inCurrentGrid || !assetsRegistered) {
        orphanCount++;
      }
    }

    // Filter queue berdasarkan scope
    let queuedItems: PlanCombination[] = [];

    if (scope === "all") {
      queuedItems = allCombinations.filter((c) => c.status === "QUEUED" || c.status === "STALE");
    } else if (scope === "stale") {
      queuedItems = allCombinations.filter((c) => c.status === "STALE");
    } else {
      // Default: 'new'. Kombinasi QUEUED tetap masuk antrean jika:
      // - belum ada entri manifest, atau
      // - entri FAILED (retry), atau
      // - entri DONE tetapi gagal verifikasi (integritas file), atau
      // - ada aset yang belum pernah dipakai di output DONE.
      queuedItems = allCombinations.filter((c) => {
        if (c.status !== "QUEUED") return false;

        const existingOutput = manifest.outputs[c.filename];
        if (!existingOutput) return true;
        if (existingOutput.status === "FAILED") return true;
        if (existingOutput.status === "DONE" && verificationResults.get(c.filename)?.valid !== true) {
          return true;
        }

        const isNewAsset =
          !usedHooksInDone.has(c.hookFile) ||
          !usedBodiesInDone.has(c.bodyFile) ||
          !usedCtasInDone.has(c.ctaFile);
        return isNewAsset;
      });
    }

    // Pilih backsound untuk setiap item yang akan dirender. Output DONE yang
    // sudah punya track valid tidak diubah; hanya item QUEUED/STALE yang dipilih.
    queuedItems = queuedItems.map((combo, index) => {
      const picked = pickMusic(combo.key, index);
      return {
        ...combo,
        musicFile: picked?.file ?? null,
        musicItem: picked?.item ?? null,
      };
    });

    // Estimasi ukuran dari output DONE yang sudah ada, fallback 18 MB.
    const doneSizes = Object.values(manifest.outputs)
      .filter((out) => out.status === "DONE" && out.sizeBytes > 0)
      .map((out) => out.sizeBytes);
    const avgOutputMb = doneSizes.length > 0
      ? Math.round((doneSizes.reduce((sum, size) => sum + size, 0) / doneSizes.length / (1024 * 1024)) * 10) / 10
      : 18.0;

    const requiredMb = Math.ceil(queuedItems.length * avgOutputMb * 1.15 + 500);
    const workers = product.render.workers || 3;
    const etaSeconds = Math.ceil((queuedItems.length * 0.4) / workers);

    // Disk bebas nyata. -1 berarti tidak bisa dibaca (jangan blokir karena itu).
    let freeMb = -1;
    try {
      const stats = fs.statfsSync(outputDir);
      const freeBytes = Number(stats.bsize) * Number(stats.bavail);
      if (Number.isFinite(freeBytes) && freeBytes >= 0) {
        freeMb = Math.floor(freeBytes / (1024 * 1024));
      }
    } catch {
      // Biarkan -1; UI menampilkan "-" dan render tidak diblokir.
    }

    const blockers: string[] = [];
    const warnings: string[] = [];

    if (totalCombinations > product.limits.maxCombinations) {
      blockers.push(`Total kombinasi (${totalCombinations}) melebihi batas maksimal ${product.limits.maxCombinations}.`);
    } else if (totalCombinations > product.limits.warnCombinations) {
      warnings.push(`Jumlah kombinasi cukup besar (${totalCombinations} video).`);
    }

    if (freeMb >= 0 && freeMb < requiredMb) {
      blockers.push(`Ruang disk tidak cukup: butuh sekitar ${requiredMb} MB, tersedia ${freeMb} MB.`);
    } else if (freeMb >= 0 && queuedItems.length > 0 && freeMb < requiredMb * 1.15) {
      warnings.push(`Ruang disk tersisa ${freeMb} MB, mendekati kebutuhan sekitar ${requiredMb} MB.`);
    }

    if (invalidDoneCount > 0) {
      warnings.push(
        `${invalidDoneCount} output berstatus DONE tidak lolos verifikasi integritas dan akan dirender ulang.`
      );
    }

    if (product.music.enabled && musicTracks.length === 0 && hasMusicFiles) {
      warnings.push("Backsound aktif, tetapi tidak ada track READY di folder backsounds. Render akan berjalan tanpa backsound.");
    }
    if (
      product.music.enabled &&
      product.music.selection === "fixed" &&
      product.music.fixedFile &&
      !musicTracks.some(([file]) => file === product.music.fixedFile)
    ) {
      warnings.push(
        `Backsound fixedFile "${product.music.fixedFile}" tidak ditemukan. Sistem memakai track READY pertama.`
      );
    }
    if (musicAvailable && queuedItems.length > 0) {
      warnings.push(
        `Backsound aktif: ${musicTracks.length} track tersedia, dipilih otomatis per output (${product.music.selection}).`
      );
    }

    if (queuedItems.length > 0) {
      warnings.push(`${queuedItems.length} video baru siap di-generate (estimasi sekitar ${(queuedItems.length * avgOutputMb).toFixed(0)} MB).`);
    }

    return {
      counts: {
        hooks: hooks.length,
        bodies: bodies.length,
        ctas: ctas.length,
        music: musicTracks.length,
        total: totalCombinations,
        done: doneCount,
        stale: staleCount,
        orphan: orphanCount,
        queued: queuedItems.length,
      },
      scope,
      queue: queuedItems,
      estimate: {
        avgOutputMb,
        requiredMb,
        freeMb,
        etaSeconds,
      },
      blockers,
      warnings,
    };
  }

  /**
   * Durasi ekspektasi berasal dari entri manifest. Untuk entri lama yang durasinya 0,
   * fallback ke jumlah durasi aset di registry (tetap deterministik).
   */
  private static resolveExpectedDuration(out: OutputItem, registry: AssetsRegistry): number {
    if (Number.isFinite(out.durationSeconds) && out.durationSeconds > 0) {
      return out.durationSeconds;
    }

    const parts = [
      registry.assets.hook[out.hook]?.durationSeconds,
      registry.assets.body[out.body]?.durationSeconds,
      registry.assets.cta[out.cta]?.durationSeconds,
    ];

    if (parts.some((value) => !Number.isFinite(value) || (value ?? 0) <= 0)) {
      return 0; // tidak diketahui -> verifikasi durasi akan menolak
    }

    return parts.reduce((sum, value) => sum + (value ?? 0), 0);
  }
}
