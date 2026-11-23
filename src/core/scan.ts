import fs from "node:fs";
import path from "node:path";
import { AssetKind, AssetsRegistry, AssetItem } from "../schemas/assets.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { NamingUtils } from "./naming.js";
import { IngestEngine } from "./ingest.js";
import { FingerprintService } from "./fingerprint.js";
import { AUDIO_EXTENSIONS } from "./mediaFormats.js";

export interface ScanSkippedFile {
  file: string;
  reason: "hidden" | "temporary" | "ext";
}

export interface ScanFolderReport {
  kind: AssetKind;
  dirPath: string;
  exists: boolean;
  readable: boolean;
  filesSeen: string[];
  skipped: ScanSkippedFile[];
}

export interface ScanMissingEntry {
  kind: AssetKind;
  file: string;
  sizeBytes: number;
}

export interface ScanReport {
  specHash: string;
  scannedAt: string;
  folders: ScanFolderReport[];
  missing: ScanMissingEntry[];
  counts: Record<AssetKind, { ready: number; error: number; missing: number }>;
}

export interface ScanResult {
  registry: AssetsRegistry;
  report: ScanReport;
}

export interface PruneResult {
  registry: AssetsRegistry;
  removed: { kind: AssetKind; file: string; sizeBytes: number }[];
  skippedKinds: AssetKind[];
}

export class ScanFolderUnreadableError extends Error {
  public readonly dirPath: string;
  public readonly causeCode: string | undefined;

  constructor(dirPath: string, cause: unknown) {
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : undefined;
    super(
      `Folder database tidak dapat dibaca: ${dirPath}${code ? ` (${code})` : ""}. Periksa izin/drive, lalu Pindai Ulang.`
    );
    this.name = "ScanFolderUnreadableError";
    this.dirPath = dirPath;
    this.causeCode = code;
  }
}

const MISSING_FILE_ERROR =
  'File tidak ditemukan di folder database. Kembalikan nama file lalu Pindai Ulang, atau hapus entri dengan "Bersihkan entri hilang".';

export class ScanEngine {
  private static readonly KINDS: AssetKind[] = ["hook", "body", "cta", "music"];
  private static readonly FOLDER_NAMES: Record<AssetKind, string> = {
    hook: "hooks",
    body: "bodies",
    cta: "ctas",
    music: "backsounds",
  };

  /**
   * Cek magic bytes untuk memastikan file benar-benar MP4/QuickTime (offset 4 adalah 'ftyp').
   */
  public static isValidMp4Magic(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < 12) return false;

      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(8);
      fs.readSync(fd, buffer, 0, 8, 4);
      fs.closeSync(fd);

      return buffer.toString("ascii", 0, 4) === "ftyp";
    } catch {
      return false;
    }
  }

  /**
   * Cache dianggap hilang jika file tidak ada, tidak bisa dibaca, atau berukuran 0.
   */
  private static isCacheFileMissing(cachePath: string): boolean {
    try {
      return fs.statSync(cachePath).size === 0;
    } catch {
      return true;
    }
  }

  private static ensureDir(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
      throw new ScanFolderUnreadableError(dirPath, err);
    }
  }

  private static listFolderFiles(
    dirPath: string,
    kind: AssetKind
  ): { files: string[]; skipped: ScanSkippedFile[] } {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      throw new ScanFolderUnreadableError(dirPath, err);
    }

    const files: string[] = [];
    const skipped: ScanSkippedFile[] = [];
    const audioAllowed = kind === "music";

    for (const entry of entries) {
      const file = entry.name;
      if (!entry.isFile()) {
        // Abaikan direktori/symlink; jangan tandai sebagai aset hilang.
        continue;
      }
      if (file.startsWith(".")) {
        skipped.push({ file, reason: "hidden" });
        continue;
      }
      if (file.endsWith(".part") || file.endsWith(".tmp")) {
        skipped.push({ file, reason: "temporary" });
        continue;
      }

      const ext = path.extname(file).toLowerCase();
      const supported = audioAllowed ? AUDIO_EXTENSIONS.has(ext) : ext === ".mp4";
      if (!supported) {
        skipped.push({ file, reason: "ext" });
        continue;
      }
      files.push(file);
    }

    return { files, skipped };
  }

  /**
   * Nama file aset yang benar-benar akan diproses untuk folder tertentu.
   * Dipakai juga oleh diagnostik server agar konsisten dengan scan/prune.
   * Melempar ScanFolderUnreadableError bila folder tidak bisa dibaca.
   */
  public static listAssetFileNames(dirPath: string, kind: AssetKind): string[] {
    return this.listFolderFiles(dirPath, kind).files;
  }

  private static cloneRegistry(currentRegistry: AssetsRegistry, specHash: string): AssetsRegistry {
    const cloneBucket = (bucket: Record<string, AssetItem>): Record<string, AssetItem> => {
      const out: Record<string, AssetItem> = {};
      for (const [k, v] of Object.entries(bucket)) out[k] = { ...v };
      return out;
    };
    return {
      schemaVersion: 1,
      specHash,
      assets: {
        hook: cloneBucket(currentRegistry.assets.hook),
        body: cloneBucket(currentRegistry.assets.body),
        cta: cloneBucket(currentRegistry.assets.cta),
        music: cloneBucket(currentRegistry.assets.music),
      },
    };
  }

  /**
   * Memindai folder database/<product>/{hooks,bodies,ctas,backsounds} dan memperbarui assets.json.
   * Wrapper kompatibilitas: mengembalikan registry saja.
   */
  public static async scanProductAssets(
    productRoot: string,
    product: ProductConfig,
    currentRegistry: AssetsRegistry
  ): Promise<AssetsRegistry> {
    const { registry } = await this.scanProductAssetsDetailed(productRoot, product, currentRegistry);
    return registry;
  }

  /**
   * Scan detail: mengembalikan registry + laporan diagnostik.
   * Melempar ScanFolderUnreadableError bila folder database tidak bisa dibaca; registry tidak diubah.
   */
  public static async scanProductAssetsDetailed(
    productRoot: string,
    product: ProductConfig,
    currentRegistry: AssetsRegistry
  ): Promise<ScanResult> {
    const specHash = computeSpecHash(product.video, product.audio);
    const updatedRegistry = this.cloneRegistry(currentRegistry, specHash);
    const cacheDir = path.join(productRoot, "cache", product.slug);

    const report: ScanReport = {
      specHash,
      scannedAt: new Date().toISOString(),
      folders: [],
      missing: [],
      counts: {
        hook: { ready: 0, error: 0, missing: 0 },
        body: { ready: 0, error: 0, missing: 0 },
        cta: { ready: 0, error: 0, missing: 0 },
        music: { ready: 0, error: 0, missing: 0 },
      },
    };

    for (const kind of this.KINDS) {
      const dirPath = path.join(productRoot, "database", product.slug, this.FOLDER_NAMES[kind]);
      const existed = fs.existsSync(dirPath);
      if (!existed) {
        this.ensureDir(dirPath);
      }

      const { files, skipped } = this.listFolderFiles(dirPath, kind);
      const activeFilenames = new Set(files);
      report.folders.push({
        kind,
        dirPath,
        exists: existed,
        readable: true,
        filesSeen: files,
        skipped,
      });

      // Buat peta slug yang sudah terpakai untuk menghindari bentrok
      const usedSlugs = new Set<string>();
      for (const item of Object.values(updatedRegistry.assets[kind])) {
        usedSlugs.add(item.slug);
      }

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const isMusic = kind === "music";

        // Magic bytes hanya untuk video. Audio divalidasi oleh ffprobe saat ingest.
        if (!isMusic && !this.isValidMp4Magic(filePath)) {
          const stats = fs.statSync(filePath);
          updatedRegistry.assets[kind][file] = {
            slug: NamingUtils.toSlug(file),
            enabled: false,
            sha256: "corrupt",
            sizeBytes: stats.size,
            mtimeMs: stats.mtimeMs,
            durationSeconds: 0,
            origin: "scan",
            status: "ERROR",
            ingestedAt: new Date().toISOString(),
            error: "File korup atau bukan MP4 yang valid (magic bytes mismatch)",
          };
          continue;
        }

        // Tentukan slug stabil
        const existingItem = updatedRegistry.assets[kind][file];
        let slug = existingItem?.slug;

        if (!slug) {
          const baseSlug = NamingUtils.toSlug(file, product.naming.maxSlugLength);
          slug = baseSlug;
          let counter = 2;
          while (usedSlugs.has(slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
          }
          usedSlugs.add(slug);
        }

        // Cek apakah file berubah (mtime / size) atau cache kanonik untuk specHash ini hilang
        const fingerprint = await FingerprintService.getFingerprint(filePath);
        const expectedCachePath = isMusic
          ? IngestEngine.normalizedMusicPath(cacheDir, fingerprint.sha256, slug, specHash)
          : IngestEngine.normalizedCachePath(cacheDir, fingerprint.sha256, slug, specHash);
        const cacheMissing = existingItem?.status === "READY" && this.isCacheFileMissing(expectedCachePath);
        const isModified =
          !existingItem ||
          existingItem.sizeBytes !== fingerprint.sizeBytes ||
          Math.abs(existingItem.mtimeMs - fingerprint.mtimeMs) > 10 ||
          currentRegistry.specHash !== specHash ||
          cacheMissing;

        if (isModified || existingItem?.status !== "READY") {
          try {
            const ingested = isMusic
              ? await IngestEngine.ingestMusic(filePath, slug, product, cacheDir)
              : await IngestEngine.ingestClip(filePath, slug, product, cacheDir);
            updatedRegistry.assets[kind][file] = ingested;
          } catch (err) {
            updatedRegistry.assets[kind][file] = {
              slug,
              enabled: false,
              sha256: fingerprint.sha256,
              sizeBytes: fingerprint.sizeBytes,
              mtimeMs: fingerprint.mtimeMs,
              durationSeconds: 0,
              origin: "scan",
              status: "ERROR",
              ingestedAt: new Date().toISOString(),
              error: (err as Error).message,
            };
          }
        }
      }

      // Tandai file yang hilang di folder sebagai ERROR / tidak aktif
      const missingFiles = new Set<string>();
      for (const existingFile of Object.keys(updatedRegistry.assets[kind])) {
        if (!activeFilenames.has(existingFile)) {
          const item = updatedRegistry.assets[kind][existingFile];
          if (item) {
            updatedRegistry.assets[kind][existingFile] = {
              ...item,
              enabled: false,
              status: "ERROR",
              error: MISSING_FILE_ERROR,
            };
            missingFiles.add(existingFile);
            report.missing.push({ kind, file: existingFile, sizeBytes: item.sizeBytes });
            report.counts[kind].missing += 1;
          }
        }
      }

      // `error` di sini hanya untuk ERROR non-hilang (mis. korup/gagal ingest);
      // entri hilang sudah dihitung terpisah di `missing`.
      for (const [file, item] of Object.entries(updatedRegistry.assets[kind])) {
        if (item.status === "READY") report.counts[kind].ready += 1;
        else if (item.status === "ERROR" && !missingFiles.has(file)) report.counts[kind].error += 1;
      }
    }

    return { registry: updatedRegistry, report };
  }

  /**
   * Hapus entri aset yang filenya benar-benar tidak ada di folder database.
   * Folder yang tidak ada/tidak terbaca dilewati (tidak dihapus entrinya),
   * agar drive/OneDrive yang sementara putus tidak menghapus riwayat aset.
   */
  public static pruneMissingAssets(
    productRoot: string,
    product: ProductConfig,
    currentRegistry: AssetsRegistry
  ): PruneResult {
    const specHash = computeSpecHash(product.video, product.audio);
    const updatedRegistry = this.cloneRegistry(currentRegistry, specHash);
    const removed: { kind: AssetKind; file: string; sizeBytes: number }[] = [];
    const skippedKinds: AssetKind[] = [];

    for (const kind of this.KINDS) {
      const dirPath = path.join(productRoot, "database", product.slug, this.FOLDER_NAMES[kind]);

      let files: string[];
      try {
        if (!fs.existsSync(dirPath)) {
          // Folder tidak ada: lewati, jangan hapus entri.
          skippedKinds.push(kind);
          continue;
        }
        files = this.listFolderFiles(dirPath, kind).files;
      } catch {
        // Folder tidak terbaca (izin/drive): lewati, jangan hapus entri.
        skippedKinds.push(kind);
        continue;
      }

      const activeFilenames = new Set(files);

      for (const existingFile of Object.keys(updatedRegistry.assets[kind])) {
        if (!activeFilenames.has(existingFile)) {
          const item = updatedRegistry.assets[kind][existingFile];
          if (item) {
            removed.push({ kind, file: existingFile, sizeBytes: item.sizeBytes });
          }
          delete updatedRegistry.assets[kind][existingFile];
        }
      }
    }

    return { registry: updatedRegistry, removed, skippedKinds };
  }
}
