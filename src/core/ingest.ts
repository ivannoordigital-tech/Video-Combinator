import fs from "node:fs";
import path from "node:path";
import { FFmpegResolver } from "./ffmpeg.js";
import { VideoProbe } from "./probe.js";
import { FingerprintService } from "./fingerprint.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { AssetItem } from "../schemas/assets.js";
import { AppError } from "../schemas/errors.js";
import { FPS_TOLERANCE } from "./verify.js";

interface CanonicalCheck {
  ok: boolean;
  reason: string;
}

const SQUARE_SAR = "1:1";

export class IngestEngine {
  /**
   * Helper publik untuk RenderEngine: path cache kanonik dari root produk.
   * cache/<product>/ingest/<sha8>__<specHash8>__<slug>.mp4
   */
  public static getNormalizedCachePath(
    productRoot: string,
    product: ProductConfig,
    sha256: string,
    slug: string
  ): string {
    const cacheDir = path.join(productRoot, "cache", product.slug);
    const specHash = computeSpecHash(product.video, product.audio);
    return this.normalizedCachePath(cacheDir, sha256, slug, specHash);
  }

  /**
   * Path cache kanonik bila cacheDir (cache/<product>) dan specHash sudah diketahui.
   * specHash disertakan agar perubahan CRF/preset/profile/level/GOP/fps tidak
   * pernah memakai ulang file normalisasi dari spesifikasi lama.
   */
  public static normalizedCachePath(
    cacheDir: string,
    sha256: string,
    slug: string,
    specHash: string
  ): string {
    const ingestDir = path.join(cacheDir, "ingest");
    return path.join(ingestDir, this.buildNormalizedName(sha256, slug, specHash));
  }

  private static buildNormalizedName(sha256: string, slug: string, specHash: string): string {
    return `${sha256.slice(0, 8)}__${specHash.slice(0, 8)}__${slug}.mp4`;
  }

  /**
   * Path cache backsound yang sudah dinormalisasi ke audio kanonik.
   * cache/<product>/music/<sha8>__<specHash8>__<slug>.m4a
   */
  public static getMusicCachePath(
    productRoot: string,
    product: ProductConfig,
    sha256: string,
    slug: string
  ): string {
    const cacheDir = path.join(productRoot, "cache", product.slug);
    const specHash = computeSpecHash(product.video, product.audio);
    return this.normalizedMusicPath(cacheDir, sha256, slug, specHash);
  }

  public static normalizedMusicPath(
    cacheDir: string,
    sha256: string,
    slug: string,
    specHash: string
  ): string {
    const musicDir = path.join(cacheDir, "music");
    return path.join(musicDir, `${sha256.slice(0, 8)}__${specHash.slice(0, 8)}__${slug}.m4a`);
  }

  /**
   * Nama lama tanpa specHash. Dipertahankan sebagai hardlink/copy agar
   * RenderEngine yang masih membaca pola lama tetap menemukan klip kanonik.
   */
  private static legacyCachePath(cacheDir: string, sha256: string, slug: string): string {
    return path.join(cacheDir, "ingest", `${sha256.slice(0, 8)}__${slug}.mp4`);
  }

  /**
   * Menormalisasi satu klip mentah menjadi klip kanonik yang siap di-stream copy.
   * Hasil disimpan di: cache/<product>/ingest/<sha8>__<specHash8>__<slug>.mp4
   */
  public static async ingestClip(
    inputPath: string,
    slug: string,
    product: ProductConfig,
    cacheDir: string
  ): Promise<AssetItem> {
    if (!fs.existsSync(inputPath)) {
      throw new AppError("E_INPUT_CORRUPT", `File sumber tidak ditemukan: ${inputPath}`);
    }

    // 1. Probe sumber
    const probe = await VideoProbe.probeFile(inputPath);
    if (!probe.videoStream) {
      throw new AppError("E_NO_VIDEO_STREAM", `File tidak memiliki stream video: ${inputPath}`);
    }

    if (probe.durationSeconds > product.limits.maxClipSeconds) {
      throw new AppError(
        "E_INPUT_TOO_LONG",
        `Durasi video (${probe.durationSeconds.toFixed(1)}s) melebihi batas ${product.limits.maxClipSeconds}s: ${inputPath}`
      );
    }

    // 2. Hitung fingerprint sumber
    const fingerprint = await FingerprintService.getFingerprint(inputPath);
    const specHash = computeSpecHash(product.video, product.audio);
    const sha8 = fingerprint.sha256.slice(0, 8);

    const ingestDir = path.join(cacheDir, "ingest");
    fs.mkdirSync(ingestDir, { recursive: true });

    const normalizedPath = this.normalizedCachePath(cacheDir, fingerprint.sha256, slug, specHash);
    const partPath = normalizedPath.replace(/\.mp4$/, ".part");
    const legacyPath = this.legacyCachePath(cacheDir, fingerprint.sha256, slug);

    // 3. Cek cache hanya jika signature lengkap cocok dengan spesifikasi produk
    if (fs.existsSync(normalizedPath)) {
      try {
        const cachedProbe = await VideoProbe.probeFile(normalizedPath);
        const check = this.validateCanonicalProbe(cachedProbe, product);
        if (check.ok) {
          this.ensureLegacyAlias(normalizedPath, legacyPath);
          return {
            slug,
            enabled: true,
            sha256: fingerprint.sha256,
            sizeBytes: fingerprint.sizeBytes,
            mtimeMs: fingerprint.mtimeMs,
            durationSeconds: cachedProbe.durationSeconds,
            origin: "scan",
            status: "READY",
            ingestedAt: new Date().toISOString(),
            error: null,
          };
        }
        // Cache tidak cocok spesifikasi -> encode ulang (file lama dibersihkan di bawah)
      } catch {
        // Jika file cache korup, lanjutkan encode ulang
      }
    }

    // 4. Bangun filter video kanonik
    const w = product.video.width;
    const h = product.video.height;
    const fps = product.video.fps;
    const vf =
      product.video.fit === "crop"
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=${product.video.pixFmt}`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=${product.video.pixFmt}`;

    const hasAudio = !!probe.audioStream;

    const ffmpegArgs: string[] = ["-y", "-hide_banner", "-nostdin", "-loglevel", "error"];

    if (hasAudio) {
      ffmpegArgs.push(
        "-i", inputPath,
        "-vf", vf,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "libx264", "-preset", product.video.preset, "-crf", String(product.video.crf),
        "-profile:v", product.video.profile, "-level:v", product.video.level,
        "-x264-params", `keyint=${product.video.gop}:min-keyint=${product.video.gop}:scenecut=0:force-cfr=1`,
        "-c:a", "aac", "-b:a", product.audio.bitrate, "-ar", String(product.audio.sampleRate), "-ac", String(product.audio.channels),
        "-af", `loudnorm=I=${product.audio.targetLufs}:TP=-1.5:LRA=11`,
        "-movflags", "+faststart", "-video_track_timescale", "15360",
        "-f", "mp4", partPath
      );
    } else {
      // Tanpa audio -> inject anullsrc
      ffmpegArgs.push(
        "-i", inputPath,
        "-f", "lavfi", "-i", `anullsrc=r=${product.audio.sampleRate}:cl=stereo`,
        "-vf", vf,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", product.video.preset, "-crf", String(product.video.crf),
        "-profile:v", product.video.profile, "-level:v", product.video.level,
        "-x264-params", `keyint=${product.video.gop}:min-keyint=${product.video.gop}:scenecut=0:force-cfr=1`,
        "-c:a", "aac", "-b:a", product.audio.bitrate, "-ar", String(product.audio.sampleRate), "-ac", String(product.audio.channels),
        "-shortest",
        "-movflags", "+faststart", "-video_track_timescale", "15360",
        "-f", "mp4", partPath
      );
    }

    try {
      await FFmpegResolver.executeFfmpeg(ffmpegArgs);

      // Verifikasi output terhadap signature kanonik lengkap
      const verifyProbe = await VideoProbe.probeFile(partPath);
      const check = this.validateCanonicalProbe(verifyProbe, product);
      if (!check.ok) {
        throw new AppError(
          "E_VERIFY_FAILED",
          `Hasil normalisasi ingest tidak memenuhi spesifikasi kanonik (${check.reason}): ${partPath}`
        );
      }

      // Rename atomik .part -> .mp4 (hapus target lama bila ada agar rename di Windows berhasil)
      if (fs.existsSync(normalizedPath)) {
        try {
          fs.unlinkSync(normalizedPath);
        } catch {
          // biarkan rename di bawah melaporkan error bila masih terkunci
        }
      }
      fs.renameSync(partPath, normalizedPath);
      this.ensureLegacyAlias(normalizedPath, legacyPath);

      // Bersihkan cache spesifikasi lama untuk sumber+slug yang sama (hanya di dalam ingestDir)
      this.cleanupStaleCacheEntries(ingestDir, sha8, slug, new Set([path.basename(normalizedPath), path.basename(legacyPath)]));

      return {
        slug,
        enabled: true,
        sha256: fingerprint.sha256,
        sizeBytes: fingerprint.sizeBytes,
        mtimeMs: fingerprint.mtimeMs,
        durationSeconds: verifyProbe.durationSeconds,
        origin: "scan",
        status: "READY",
        ingestedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      if (fs.existsSync(partPath)) {
        fs.unlinkSync(partPath);
      }
      throw err;
    }
  }

  /**
   * Menormalisasi file backsound menjadi audio kanonik (AAC, sample rate dan
   * channel sesuai produk). Video tidak disentuh karena backsound audio-only.
   */
  public static async ingestMusic(
    inputPath: string,
    slug: string,
    product: ProductConfig,
    cacheDir: string
  ): Promise<AssetItem> {
    if (!fs.existsSync(inputPath)) {
      throw new AppError("E_INPUT_CORRUPT", `File backsound tidak ditemukan: ${inputPath}`);
    }

    const sourceStats = fs.statSync(inputPath);
    const maxBytes = product.limits.maxAssetSizeMb * 1024 * 1024;
    if (sourceStats.size > maxBytes) {
      throw new AppError(
        "E_INPUT_TOO_LONG",
        `Ukuran backsound (${(sourceStats.size / 1024 / 1024).toFixed(1)} MB) melebihi batas ${product.limits.maxAssetSizeMb} MB: ${inputPath}`
      );
    }

    const probe = await VideoProbe.probeAudioFile(inputPath);
    if (!probe.audioStream) {
      throw new AppError("E_INPUT_CORRUPT", `File backsound tidak memiliki stream audio: ${inputPath}`);
    }
    if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
      throw new AppError("E_INPUT_CORRUPT", `Durasi backsound tidak valid: ${inputPath}`);
    }

    const fingerprint = await FingerprintService.getFingerprint(inputPath);
    const specHash = computeSpecHash(product.video, product.audio);
    const musicDir = path.join(cacheDir, "music");
    fs.mkdirSync(musicDir, { recursive: true });

    const normalizedPath = this.normalizedMusicPath(cacheDir, fingerprint.sha256, slug, specHash);
    const partPath = path.join(
      musicDir,
      `${fingerprint.sha256.slice(0, 8)}__${specHash.slice(0, 8)}__${slug}.part`
    );

    if (fs.existsSync(normalizedPath)) {
      try {
        const cached = await VideoProbe.probeAudioFile(normalizedPath);
        if (
          cached.audioStream &&
          Number(cached.audioStream.sample_rate) === product.audio.sampleRate &&
          cached.audioStream.channels === product.audio.channels &&
          Number.isFinite(cached.durationSeconds) &&
          cached.durationSeconds > 0
        ) {
          return {
            slug,
            enabled: true,
            sha256: fingerprint.sha256,
            sizeBytes: fingerprint.sizeBytes,
            mtimeMs: fingerprint.mtimeMs,
            durationSeconds: cached.durationSeconds,
            origin: "scan",
            status: "READY",
            ingestedAt: new Date().toISOString(),
            error: null,
          };
        }
      } catch {
        // Cache korup, encode ulang.
      }
    }

    const args = [
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", inputPath,
      "-vn", "-map", "0:a:0",
      "-c:a", "aac", "-b:a", product.audio.bitrate,
      "-ar", String(product.audio.sampleRate),
      "-ac", String(product.audio.channels),
      "-movflags", "+faststart",
      "-f", "mp4", partPath,
    ];

    try {
      await FFmpegResolver.executeFfmpeg(args, 300000);

      const verify = await VideoProbe.probeAudioFile(partPath);
      if (
        !verify.audioStream ||
        Number(verify.audioStream.sample_rate) !== product.audio.sampleRate ||
        verify.audioStream.channels !== product.audio.channels ||
        !Number.isFinite(verify.durationSeconds) ||
        verify.durationSeconds <= 0
      ) {
        throw new AppError("E_VERIFY_FAILED", `Hasil normalisasi backsound tidak memenuhi spesifikasi: ${partPath}`);
      }

      fs.renameSync(partPath, normalizedPath);

      return {
        slug,
        enabled: true,
        sha256: fingerprint.sha256,
        sizeBytes: fingerprint.sizeBytes,
        mtimeMs: fingerprint.mtimeMs,
        durationSeconds: verify.durationSeconds,
        origin: "scan",
        status: "READY",
        ingestedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      if (fs.existsSync(partPath)) {
        try {
          fs.unlinkSync(partPath);
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  /**
   * Validasi cache hit terhadap spesifikasi produk secara lengkap:
   * resolusi, fps, pix_fmt, SAR 1:1, profile, level, codec audio, sample rate, channel.
   */
  private static validateCanonicalProbe(
    probe: Awaited<ReturnType<typeof VideoProbe.probeFile>>,
    product: ProductConfig
  ): CanonicalCheck {
    const v = probe.videoStream;
    const a = probe.audioStream;

    if (!v) return { ok: false, reason: "tidak ada stream video" };
    if (!a) return { ok: false, reason: "tidak ada stream audio" };

    if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
      return { ok: false, reason: "durasi tidak valid" };
    }

    if ((v.codec_name || "").toLowerCase() !== product.video.codec) {
      return { ok: false, reason: `codec video ${v.codec_name || "?"} != ${product.video.codec}` };
    }

    if (v.width !== product.video.width || v.height !== product.video.height) {
      return {
        ok: false,
        reason: `resolusi ${v.width}x${v.height} != ${product.video.width}x${product.video.height}`,
      };
    }

    if (!Number.isFinite(probe.fps) || Math.abs(probe.fps - product.video.fps) > FPS_TOLERANCE) {
      return {
        ok: false,
        reason: `fps ${probe.fps} != ${product.video.fps} (toleransi ${FPS_TOLERANCE} fps)`,
      };
    }

    if ((v.pix_fmt || "").toLowerCase() !== product.video.pixFmt.toLowerCase()) {
      return { ok: false, reason: `pix_fmt ${v.pix_fmt || "?"} != ${product.video.pixFmt}` };
    }

    if (!this.isSquareSar(v.sample_aspect_ratio)) {
      return { ok: false, reason: `SAR ${v.sample_aspect_ratio || "?"} != ${SQUARE_SAR}` };
    }

    const actualProfile = (v.profile || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/^constrained/, "");
    if (actualProfile !== product.video.profile.toLowerCase()) {
      return { ok: false, reason: `profile ${v.profile || "?"} != ${product.video.profile}` };
    }

    const actualLevel = this.parseH264Level(v.level);
    const expectedLevel = this.parseH264Level(product.video.level);
    if (actualLevel === null || expectedLevel === null || actualLevel !== expectedLevel) {
      return { ok: false, reason: `level ${String(v.level ?? "?")} != ${product.video.level}` };
    }

    if (probe.rotation !== 0) {
      return { ok: false, reason: `rotasi ${probe.rotation} != 0` };
    }

    if ((a.codec_name || "").toLowerCase() !== product.audio.codec) {
      return { ok: false, reason: `codec audio ${a.codec_name || "?"} != ${product.audio.codec}` };
    }

    if (Number(a.sample_rate) !== product.audio.sampleRate) {
      return { ok: false, reason: `sample rate ${a.sample_rate} != ${product.audio.sampleRate}` };
    }

    if (a.channels !== product.audio.channels) {
      return { ok: false, reason: `channel audio ${a.channels} != ${product.audio.channels}` };
    }

    return { ok: true, reason: "" };
  }

  private static isSquareSar(sar?: string): boolean {
    if (!sar) return true;
    const normalized = sar.trim().replace("/", ":").toLowerCase();
    return normalized === "1:1" || normalized === "0:1" || normalized === "n/a";
  }

  /** ffprobe melaporkan level H.264 sebagai integer (41), konfigurasi produk sebagai "4.1". */
  private static parseH264Level(level: number | string | undefined): number | null {
    if (level === undefined || level === null || level === "") return null;
    const raw = typeof level === "number" ? level : Number(String(level).trim());
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 10 ? Math.round(raw * 10) : Math.round(raw);
  }

  /**
   * Membuat nama cache lama (tanpa specHash) menunjuk ke file kanonik terbaru.
   * Dipakai sebagai jembatan kompatibilitas untuk RenderEngine yang belum tahu
   * pola nama baru. Hardlink dipakai agar tidak menduplikasi ukuran file.
   */
  private static ensureLegacyAlias(normalizedPath: string, legacyPath: string): void {
    if (path.resolve(normalizedPath) === path.resolve(legacyPath)) return;

    try {
      const target = fs.statSync(normalizedPath);
      const existing = fs.existsSync(legacyPath) ? fs.statSync(legacyPath) : null;

      if (existing) {
        const sameInode =
          existing.ino !== 0 && target.ino !== 0 && existing.ino === target.ino && existing.dev === target.dev;
        const sameMetadata =
          Math.abs(existing.size - target.size) === 0 && Math.abs(existing.mtimeMs - target.mtimeMs) < 1;
        if (sameInode || sameMetadata) return;
        try {
          fs.unlinkSync(legacyPath);
        } catch {
          // Jika masih terkunci, biarkan file lama; render akan memakai cache spesifikasi baru.
          return;
        }
      }

      try {
        fs.linkSync(normalizedPath, legacyPath);
      } catch {
        fs.copyFileSync(normalizedPath, legacyPath);
      }
    } catch {
      // Alias bersifat best-effort; kegagalan tidak boleh menggagalkan ingest.
    }
  }

  /**
   * Hapus cache spesifikasi lama untuk sumber (sha8) + slug yang sama.
   * Hanya menyentuh file yang cocok pola di dalam cache/<slug>/ingest.
   */
  private static cleanupStaleCacheEntries(
    ingestDir: string,
    sha8: string,
    slug: string,
    keepNames: Set<string>
  ): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(ingestDir);
    } catch {
      return;
    }

    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${sha8}__[0-9a-f]{8}__${escapedSlug}\\.(mp4|part)$`);
    const resolvedDir = path.resolve(ingestDir);

    for (const name of entries) {
      if (keepNames.has(name)) continue;
      if (!pattern.test(name)) continue;

      const target = path.resolve(ingestDir, name);
      // Jangan pernah menghapus apa pun di luar cache/<slug>/ingest
      if (path.dirname(target) !== resolvedDir) continue;

      try {
        fs.rmSync(target, { force: true });
      } catch {
        // File mungkin sedang dipakai proses lain; biarkan.
      }
    }
  }
}
