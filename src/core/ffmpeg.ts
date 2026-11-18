import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../schemas/errors.js";

const execFileAsync = promisify(execFile);

export interface BinaryHealth {
  ok: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
}

export class FFmpegResolver {
  private static cachedHealth: BinaryHealth | null = null;

  public static getRootDir(): string {
    let curr = import.meta.dirname;
    while (curr !== path.dirname(curr)) {
      if (fs.existsSync(path.join(curr, "package.json"))) {
        return curr;
      }
      curr = path.dirname(curr);
    }
    return process.cwd();
  }

  public static getFfmpegPath(): string {
    const root = this.getRootDir();
    const localBin = path.join(root, "bin", "ffmpeg.exe");
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    // Fallback to ffmpeg on PATH
    return "ffmpeg";
  }

  public static getFfprobePath(): string {
    const root = this.getRootDir();
    const localBin = path.join(root, "bin", "ffprobe.exe");
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    return "ffprobe";
  }

  public static async checkHealth(force = false): Promise<BinaryHealth> {
    if (!force && this.cachedHealth) {
      return this.cachedHealth;
    }

    const ffmpegPath = this.getFfmpegPath();
    const ffprobePath = this.getFfprobePath();

    try {
      const [ffmpegRes, ffprobeRes] = await Promise.all([
        execFileAsync(ffmpegPath, ["-version"], { windowsHide: true }),
        execFileAsync(ffprobePath, ["-version"], { windowsHide: true }),
      ]);

      const ffmpegVersion = ffmpegRes.stdout.split("\n")[0]?.trim() || "unknown";
      const ffprobeVersion = ffprobeRes.stdout.split("\n")[0]?.trim() || "unknown";

      const health: BinaryHealth = {
        ok: true,
        ffmpegPath,
        ffprobePath,
        ffmpegVersion,
        ffprobeVersion,
      };

      this.cachedHealth = health;
      return health;
    } catch (err) {
      throw new AppError(
        "E_FFMPEG_MISSING",
        "FFmpeg atau FFprobe tidak dapat dijalankan di folder bin/.",
        err
      );
    }
  }

  public static async executeFfmpeg(args: string[], timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
    const bin = this.getFfmpegPath();
    return execFileAsync(bin, args, { windowsHide: true, timeout: timeoutMs });
  }

  public static async executeFfprobe(args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> {
    const bin = this.getFfprobePath();
    return execFileAsync(bin, args, { windowsHide: true, timeout: timeoutMs });
  }
}
