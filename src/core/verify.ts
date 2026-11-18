import fs from "node:fs";
import { VideoProbe } from "./probe.js";
import { ProductConfig } from "../schemas/product.js";

export interface VerificationResult {
  valid: boolean;
  durationSeconds: number;
  sizeBytes: number;
  error: string | null;
}

/** Ukuran minimum output yang dianggap utuh (50 KB). */
export const MIN_OUTPUT_BYTES = 50 * 1024;
/** Toleransi deviasi durasi sesuai PRD (0.25 detik). */
export const DURATION_TOLERANCE_SECONDS = 0.25;
/** Toleransi deviasi fps output terhadap target produk. */
export const FPS_TOLERANCE = 0.02;

function isSquarePixelSar(sar?: string): boolean {
  if (!sar) return true; // tidak dispesifikasikan -> dianggap 1:1 (setsar=1 sudah diterapkan)
  const normalized = sar.trim().replace("/", ":").toLowerCase();
  return normalized === "1:1" || normalized === "0:1" || normalized === "n/a";
}

/**
 * Pemeriksaan struktur container MP4 yang murah (tanpa ffprobe):
 * menelusuri box top-level dan memastikan semuanya berada di dalam batas file.
 * File ter-truncate tetap bisa di-probe karena moov berada di depan (faststart),
 * sehingga pemeriksaan batas box ini diperlukan untuk mendeteksi mdat yang terpotong.
 */
export function isMp4StructurallyIntact(filePath: string, fileSize?: number): boolean {
  let size = fileSize;
  if (size === undefined) {
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return false;
    }
  }

  if (!Number.isFinite(size) || size < 8) return false;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(16);
    let offset = 0;

    // Batas wajar jumlah box top-level untuk mencegah loop patologis.
    for (let guard = 0; guard < 4096; guard++) {
      if (offset === size) return true;
      if (size - offset < 8) return false;

      const read = fs.readSync(fd, header, 0, 16, offset);
      if (read < 8) return false;

      let boxSize = header.readUInt32BE(0);
      const boxType = header.toString("ascii", 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(boxType)) return false;

      if (boxSize === 1) {
        if (read < 16) return false;
        boxSize = header.readUInt32BE(8) * 2 ** 32 + header.readUInt32BE(12);
      } else if (boxSize === 0) {
        // Box berukuran "sampai akhir file" (umum untuk mdat).
        boxSize = size - offset;
      }

      if (!Number.isFinite(boxSize) || boxSize < 8) return false;
      if (offset + boxSize > size) return false;

      offset += boxSize;
    }

    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export class OutputVerifier {
  public static async verifyOutput(
    filePath: string,
    expectedDuration: number,
    product: ProductConfig
  ): Promise<VerificationResult> {
    if (!fs.existsSync(filePath)) {
      return { valid: false, durationSeconds: 0, sizeBytes: 0, error: "File output tidak ditemukan" };
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { valid: false, durationSeconds: 0, sizeBytes: 0, error: "Path output bukan file reguler" };
    }

    if (stats.size < MIN_OUTPUT_BYTES) {
      // Kurang dari 50 KB
      return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: "Ukuran file terlalu kecil (< 50 KB)" };
    }

    // Integritas struktur container: tolak file ter-truncate meski metadata (moov) masih terbaca.
    if (!isMp4StructurallyIntact(filePath, stats.size)) {
      return {
        valid: false,
        durationSeconds: 0,
        sizeBytes: stats.size,
        error: "Struktur container MP4 rusak atau ter-truncate (box melebihi ukuran file)",
      };
    }

    if (!Number.isFinite(expectedDuration) || expectedDuration < 0) {
      return {
        valid: false,
        durationSeconds: 0,
        sizeBytes: stats.size,
        error: "Durasi ekspektasi tidak valid (NaN/non-finite)",
      };
    }

    try {
      const probe = await VideoProbe.probeFile(filePath);

      // 1. Cek stream
      if (!probe.videoStream || !probe.audioStream) {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: "Harus memiliki tepat 1 video stream dan 1 audio stream" };
      }

      // 2. Cek codec video
      if (probe.videoStream.codec_name?.toLowerCase() !== "h264") {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: `Codec video salah: ${probe.videoStream.codec_name}` };
      }

      // 3. Cek resolusi
      if (probe.videoStream.width !== product.video.width || probe.videoStream.height !== product.video.height) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: `Resolusi ${probe.videoStream.width}x${probe.videoStream.height} tidak sesuai target ${product.video.width}x${product.video.height}`,
        };
      }

      // 4. Cek rotasi
      if (probe.rotation !== 0) {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: `Terdapat rotasi tersisa: ${probe.rotation}` };
      }

      // 5. Cek fps (toleransi kecil untuk pembulatan container)
      const fpsDiff = Math.abs(probe.fps - product.video.fps);
      if (!Number.isFinite(probe.fps) || probe.fps <= 0 || fpsDiff > FPS_TOLERANCE) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: `Frame rate ${probe.fps || "tidak terbaca"} fps tidak sesuai target ${product.video.fps} fps`,
        };
      }

      // 6. Cek pixel format & sample aspect ratio
      if ((probe.videoStream.pix_fmt || "").toLowerCase() !== product.video.pixFmt.toLowerCase()) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: `Pixel format ${probe.videoStream.pix_fmt || "tidak terbaca"} tidak sesuai target ${product.video.pixFmt}`,
        };
      }

      if (!isSquarePixelSar(probe.videoStream.sample_aspect_ratio)) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: `Sample aspect ratio ${probe.videoStream.sample_aspect_ratio} bukan 1:1`,
        };
      }

      // 7. Cek audio codec & format
      if (probe.audioStream.codec_name?.toLowerCase() !== "aac") {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: `Codec audio salah: ${probe.audioStream.codec_name}` };
      }

      if (
        probe.audioStream.channels !== product.audio.channels ||
        Number(probe.audioStream.sample_rate) !== product.audio.sampleRate
      ) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: `Format audio ${probe.audioStream.sample_rate} Hz/${probe.audioStream.channels} ch tidak sesuai target ${product.audio.sampleRate} Hz/${product.audio.channels} ch`,
        };
      }

      // 8. Cek durasi (toleransi ±0.25 detik sesuai PRD)
      if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
        return {
          valid: false,
          durationSeconds: 0,
          sizeBytes: stats.size,
          error: "Durasi output tidak valid (NaN/non-finite)",
        };
      }

      const diff = Math.abs(probe.durationSeconds - expectedDuration);
      if (diff > DURATION_TOLERANCE_SECONDS) {
        return {
          valid: false,
          durationSeconds: probe.durationSeconds,
          sizeBytes: stats.size,
          error: `Deviasi durasi terlalu besar (${probe.durationSeconds.toFixed(2)}s vs ekspektasi ${expectedDuration.toFixed(2)}s, toleransi ±${DURATION_TOLERANCE_SECONDS}s)`,
        };
      }

      return {
        valid: true,
        durationSeconds: probe.durationSeconds,
        sizeBytes: stats.size,
        error: null,
      };
    } catch (err) {
      return {
        valid: false,
        durationSeconds: 0,
        sizeBytes: stats.size,
        error: (err as Error).message,
      };
    }
  }
}
