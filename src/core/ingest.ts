import fs from "node:fs";
import path from "node:path";
import { FFmpegResolver } from "./ffmpeg.js";
import { VideoProbe } from "./probe.js";
import { FingerprintService } from "./fingerprint.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { AssetItem } from "../schemas/assets.js";
import { AppError } from "../schemas/errors.js";

export class IngestEngine {
  /**
   * Menormalisasi satu klip mentah menjadi klip kanonik yang siap di-stream copy.
   * Hasil disimpan di: cache/<product>/ingest/<sha8>__<slug>.mp4
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

    const normalizedPath = path.join(ingestDir, `${sha8}__${slug}.mp4`);
    const partPath = path.join(ingestDir, `${sha8}__${slug}.part`);

    // 3. Cek cache jika sudah ada file normalisasi yang valid
    if (fs.existsSync(normalizedPath)) {
      try {
        const cachedProbe = await VideoProbe.probeFile(normalizedPath);
        if (
          cachedProbe.videoStream?.width === product.video.width &&
          cachedProbe.videoStream?.height === product.video.height &&
          cachedProbe.audioStream?.sample_rate === product.audio.sampleRate
        ) {
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
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;

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

      // Verifikasi output
      const verifyProbe = await VideoProbe.probeFile(partPath);
      if (
        verifyProbe.videoStream?.width !== w ||
        verifyProbe.videoStream?.height !== h ||
        verifyProbe.rotation !== 0 ||
        !verifyProbe.audioStream
      ) {
        throw new AppError("E_VERIFY_FAILED", `Hasil normalisasi ingest tidak memenuhi spesifikasi kanonik: ${partPath}`);
      }

      // Rename atomik .part -> .mp4
      fs.renameSync(partPath, normalizedPath);

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
}
