import fs from "node:fs";
import { createHash } from "node:crypto";

export interface FileFingerprint {
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
}

export class FingerprintService {
  private static memoryCache = new Map<string, { mtimeMs: number; sizeBytes: number; sha256: string }>();

  /**
   * Menghitung sha256 file dengan cache cerdas berbasis size + mtime.
   * Jika file tidak berubah mtime & size-nya, sha256 diambil langsung dari cache.
   */
  public static async getFingerprint(filePath: string): Promise<FileFingerprint> {
    const stats = await fs.promises.stat(filePath);
    const sizeBytes = stats.size;
    const mtimeMs = stats.mtimeMs;

    const cached = this.memoryCache.get(filePath);
    if (cached && cached.sizeBytes === sizeBytes && Math.abs(cached.mtimeMs - mtimeMs) < 10) {
      return {
        sha256: cached.sha256,
        sizeBytes,
        mtimeMs,
      };
    }

    const sha256 = await this.computeSha256(filePath);
    this.memoryCache.set(filePath, { mtimeMs, sizeBytes, sha256 });

    return {
      sha256,
      sizeBytes,
      mtimeMs,
    };
  }

  public static clearCache(): void {
    this.memoryCache.clear();
  }

  private static computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", (err) => reject(err));
    });
  }
}
