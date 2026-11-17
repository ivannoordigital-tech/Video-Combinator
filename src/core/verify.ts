import fs from "node:fs";
import { VideoProbe } from "./probe.js";
import { ProductConfig } from "../schemas/product.js";

export interface VerificationResult {
  valid: boolean;
  durationSeconds: number;
  sizeBytes: number;
  error: string | null;
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
    if (stats.size < 51200) {
      // Kurang dari 50 KB
      return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: "Ukuran file terlalu kecil (< 50 KB)" };
    }

    try {
      const probe = await VideoProbe.probeFile(filePath);

      // 1. Cek stream
      if (!probe.videoStream || !probe.audioStream) {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: "Harus memiliki tepat 1 video stream dan 1 audio stream" };
      }

      // 2. Cek codec
      if (probe.videoStream.codec_name?.toLowerCase() !== "h264") {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: `Codec video salah: ${probe.videoStream.codec_name}` };
      }
      if (probe.audioStream.codec_name?.toLowerCase() !== "aac") {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: `Codec audio salah: ${probe.audioStream.codec_name}` };
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

      // 5. Cek audio specs
      if (probe.audioStream.channels !== product.audio.channels || probe.audioStream.sample_rate !== product.audio.sampleRate) {
        return { valid: false, durationSeconds: 0, sizeBytes: stats.size, error: "Format audio sample rate / channel tidak sesuai" };
      }

      // 6. Cek durasi (toleransi ±0.25 detik)
      const diff = Math.abs(probe.durationSeconds - expectedDuration);
      if (diff > 0.35) {
        return {
          valid: false,
          durationSeconds: probe.durationSeconds,
          sizeBytes: stats.size,
          error: `Deviasi durasi terlalu besar (${probe.durationSeconds.toFixed(2)}s vs ekspektasi ${expectedDuration.toFixed(2)}s)`,
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
