import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { FFmpegResolver } from "./ffmpeg.js";
import { OutputVerifier } from "./verify.js";
import { ManifestManager } from "./manifest.js";
import { ReportGenerator } from "./report.js";
import { PlanCombination } from "./plan.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { Manifest, OutputItem } from "../schemas/manifest.js";
import { Job } from "../schemas/job.js";
import { VideoProbe } from "./probe.js";
import { ScanEngine } from "./scan.js";
import { IngestEngine } from "./ingest.js";

export interface RenderEvents {
  onItemDone?: (filename: string, item: OutputItem, index: number, total: number) => void;
  onItemFailed?: (filename: string, error: string, index: number, total: number) => void;
  onProgress?: (done: number, total: number, current: string) => void;
}

/** Batas byte stderr FFmpeg yang disimpan (tail). */
const STDERR_TAIL_LIMIT = 8 * 1024;
/** Rotasi sederhana log per produk jika melebihi 10 MB. */
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 120_000;
const CANCEL_WAIT_DEFAULT_MS = 15_000;

interface FfmpegFailure extends Error {
  stderrTail?: string;
}

function summarizeStderr(raw: string): string {
  const cleaned = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  if (!cleaned) return "";
  return cleaned.length > 800 ? `...${cleaned.slice(-800)}` : cleaned;
}

function formatLogDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

export class RenderEngine {
  private activeProcesses = new Set<ChildProcess>();
  private isCancelled = false;
  private validatedInputs = new Set<string>();

  private completionPromise: Promise<Job> | null = null;
  private resolveCompletion: ((job: Job) => void) | null = null;
  private completionSettled = false;

  /**
   * Promise yang resolve saat renderQueue selesai (termasuk throw/cancel).
   * Tidak pernah reject agar pemanggil bisa menunggu tanpa try/catch tambahan.
   */
  public get completion(): Promise<Job> {
    return this.ensureCompletion();
  }

  private ensureCompletion(): Promise<Job> {
    if (!this.completionPromise) {
      this.completionPromise = new Promise<Job>((resolve) => {
        this.resolveCompletion = resolve;
      });
    }
    return this.completionPromise;
  }

  private resetCompletion(): void {
    this.completionSettled = false;
    this.completionPromise = new Promise<Job>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  private settleCompletion(job: Job): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    const resolve = this.resolveCompletion;
    this.resolveCompletion = null;
    resolve?.(job);
  }

  /**
   * Minta cancel. Kill process tree (Windows: taskkill /T /F) lalu worker akan
   * settle sendiri. Gunakan cancelAndWait() jika perlu menunggu benar-benar berhenti.
   */
  public cancel(): void {
    this.isCancelled = true;
    for (const proc of this.activeProcesses) {
      this.killProcessTree(proc);
    }
    this.activeProcesses.clear();
  }

  /**
   * Cancel lalu tunggu sampai renderQueue benar-benar settle (dibatasi timeout).
   */
  public async cancelAndWait(timeoutMs = CANCEL_WAIT_DEFAULT_MS): Promise<void> {
    this.cancel();
    const completion = this.ensureCompletion();
    if (this.completionSettled) return;

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        completion.then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async renderQueue(
    productRoot: string,
    product: ProductConfig,
    queue: PlanCombination[],
    manifest: Manifest,
    job: Job,
    events?: RenderEvents
  ): Promise<Job> {
    if (this.completionSettled) {
      this.resetCompletion();
    } else {
      this.ensureCompletion();
    }

    try {
      return await this.runRenderQueue(productRoot, product, queue, manifest, job, events);
    } catch (err) {
      // Error setup (mis. folder tidak bisa dibuat) tetap harus settle.
      if (!this.isCancelled && job.done === 0 && job.failed === 0) {
        job.status = "FAILED";
      }
      job.completedAt = job.completedAt ?? new Date().toISOString();
      throw err;
    } finally {
      this.settleCompletion(job);
    }
  }

  private async runRenderQueue(
    productRoot: string,
    product: ProductConfig,
    queue: PlanCombination[],
    manifest: Manifest,
    job: Job,
    events?: RenderEvents
  ): Promise<Job> {
    const outputDir = path.join(productRoot, "output", product.slug);
    const partsDir = path.join(outputDir, ".parts");
    fs.mkdirSync(partsDir, { recursive: true });

    const specHash = computeSpecHash(product.video, product.audio);
    const workers = product.render.workers || 3;
    const total = queue.length;

    job.status = "RUNNING";
    job.total = total;
    job.done = 0;
    job.failed = 0;

    const remainingQueue = [...queue];
    let currentIndex = 0;

    const recordFailure = (combo: PlanCombination, errorMessage: string, stderrTail = ""): void => {
      job.failed++;
      this.writeRenderLog(productRoot, product.slug, combo.filename, "FAILED", errorMessage, stderrTail);
      events?.onItemFailed?.(combo.filename, errorMessage, job.done + job.failed, total);

      const failedItem: OutputItem = {
        key: combo.key,
        hook: combo.hookFile,
        body: combo.bodyFile,
        cta: combo.ctaFile,
        status: "FAILED",
        durationSeconds: 0,
        sizeBytes: 0,
        createdAt: new Date().toISOString(),
        assetFingerprints: {
          hook: combo.hookItem.sha256,
          body: combo.bodyItem.sha256,
          cta: combo.ctaItem.sha256,
        },
        specHash,
        verified: false,
        error: errorMessage,
      };

      try {
        ManifestManager.appendItem(outputDir, manifest, combo.filename, failedItem);
      } catch (err) {
        // Kegagalan menulis manifest tidak boleh menghentikan sisa antrean.
        this.writeRenderLog(
          productRoot,
          product.slug,
          combo.filename,
          "WARN",
          `Gagal menulis manifest FAILED: ${(err as Error).message}`,
          ""
        );
      }
    };

    const renderSingle = async (combo: PlanCombination): Promise<void> => {
      if (this.isCancelled) return;

      const hookNormalized = IngestEngine.getNormalizedCachePath(
        productRoot,
        product,
        combo.hookItem.sha256,
        combo.hookItem.slug
      );
      const bodyNormalized = IngestEngine.getNormalizedCachePath(
        productRoot,
        product,
        combo.bodyItem.sha256,
        combo.bodyItem.slug
      );
      const ctaNormalized = IngestEngine.getNormalizedCachePath(
        productRoot,
        product,
        combo.ctaItem.sha256,
        combo.ctaItem.slug
      );

      const listFile = path.join(partsDir, `${combo.key}.list`);
      const partFile = path.join(partsDir, `${combo.key}.part`);
      const finalFile = path.join(outputDir, combo.filename);

      // Preflight ringan: pastikan ketiga cache normalized ada & bisa diprobe.
      const preflightError = await this.preflightInputs([hookNormalized, bodyNormalized, ctaNormalized]);
      if (this.isCancelled) return;
      if (preflightError) {
        recordFailure(combo, preflightError);
        events?.onProgress?.(job.done, total, combo.filename);
        return;
      }

      // Buat file list concat (slash format, tanpa BOM)
      const listContent = [
        `file '${hookNormalized.replace(/\\/g, "/")}'`,
        `file '${bodyNormalized.replace(/\\/g, "/")}'`,
        `file '${ctaNormalized.replace(/\\/g, "/")}'`,
      ].join("\n") + "\n";

      fs.writeFileSync(listFile, listContent, "utf-8");

      const ffmpegBin = FFmpegResolver.getFfmpegPath();
      const ffmpegArgs = [
        "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4", partFile,
      ];

      let stderrTail = "";
      let verifiedDuration = 0;
      let verifiedSize = 0;

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegBin, ffmpegArgs, {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
          });
          this.activeProcesses.add(proc);

          const stderrChunks: Buffer[] = [];
          let stderrBytes = 0;
          let settled = false;
          let timeout: NodeJS.Timeout | undefined;

          const tail = (): string => {
            const raw = Buffer.concat(stderrChunks, stderrBytes).toString("utf-8");
            return raw.length > STDERR_TAIL_LIMIT ? raw.slice(-STDERR_TAIL_LIMIT) : raw;
          };

          const finish = (err?: FfmpegFailure): void => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            this.activeProcesses.delete(proc);
            stderrTail = tail();
            if (err) reject(err);
            else resolve();
          };

          proc.stderr?.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
            stderrBytes += chunk.length;
            // Jaga memori tetap terbatas; tail() memotong tepat 8 KB terakhir.
            while (stderrBytes > STDERR_TAIL_LIMIT && stderrChunks.length > 1) {
              const removed = stderrChunks.shift();
              if (removed) stderrBytes -= removed.length;
            }
          });

          proc.on("error", (err) => {
            const failure = err as FfmpegFailure;
            failure.message = `FFmpeg tidak dapat dijalankan: ${err.message}`;
            finish(failure);
          });

          proc.on("close", (code, signal) => {
            if (code === 0) {
              finish();
              return;
            }
            const summary = summarizeStderr(tail());
            const reason = signal ? `killed by ${signal}` : `exit ${code}`;
            const failure = new Error(`FFmpeg ${reason}${summary ? `: ${summary}` : ""}`) as FfmpegFailure;
            failure.stderrTail = tail();
            finish(failure);
          });

          timeout = setTimeout(() => {
            if (settled) return;
            this.killProcessTree(proc);
            const summary = summarizeStderr(tail());
            const failure = new Error(
              `Render timeout (${RENDER_TIMEOUT_MS}ms)${summary ? `: ${summary}` : ""}`
            ) as FfmpegFailure;
            failure.stderrTail = tail();
            finish(failure);
          }, RENDER_TIMEOUT_MS);
        });

        // Verifikasi
        const expectedDuration =
          combo.hookItem.durationSeconds +
          combo.bodyItem.durationSeconds +
          combo.ctaItem.durationSeconds;

        const verifyRes = await OutputVerifier.verifyOutput(partFile, expectedDuration, product);
        if (!verifyRes.valid) {
          throw new Error(verifyRes.error || "Gagal verifikasi output");
        }

        verifiedDuration = verifyRes.durationSeconds;
        verifiedSize = verifyRes.sizeBytes;

        // Rename atomik dengan retry untuk Windows file locks (100, 300, 900, 2000 ms)
        await this.atomicRenameWithRetry(partFile, finalFile);
      } catch (err) {
        if (fs.existsSync(partFile)) {
          try { fs.unlinkSync(partFile); } catch {}
        }
        if (fs.existsSync(listFile)) {
          try { fs.unlinkSync(listFile); } catch {}
        }

        // Item yang dibatalkan tidak boleh tercatat FAILED / menambah job.failed.
        if (this.isCancelled) {
          this.writeRenderLog(
            productRoot,
            product.slug,
            combo.filename,
            "CANCELLED",
            "Render dibatalkan sebelum selesai",
            ""
          );
          events?.onProgress?.(job.done, total, combo.filename);
          return;
        }

        const failure = err as FfmpegFailure;
        const errorMessage = failure.message || "Render gagal";
        recordFailure(combo, errorMessage, failure.stderrTail ?? stderrTail);
        events?.onProgress?.(job.done, total, combo.filename);
        return;
      }

      // Hapus file list
      if (fs.existsSync(listFile)) {
        try { fs.unlinkSync(listFile); } catch {}
      }

      // Item yang sudah terverifikasi tetap dicatat DONE walau cancel datang belakangan.
      const outputItem: OutputItem = {
        key: combo.key,
        hook: combo.hookFile,
        body: combo.bodyFile,
        cta: combo.ctaFile,
        status: "DONE",
        durationSeconds: verifiedDuration,
        sizeBytes: verifiedSize,
        createdAt: new Date().toISOString(),
        assetFingerprints: {
          hook: combo.hookItem.sha256,
          body: combo.bodyItem.sha256,
          cta: combo.ctaItem.sha256,
        },
        specHash,
        verified: true,
        error: null,
      };

      // Fallback metadata bila verifikasi tidak mengisi nilai (mestinya tidak terjadi).
      if (!outputItem.sizeBytes) {
        try {
          outputItem.sizeBytes = fs.statSync(finalFile).size;
        } catch {
          // biarkan 0
        }
      }
      if (!outputItem.durationSeconds) {
        outputItem.durationSeconds =
          combo.hookItem.durationSeconds +
          combo.bodyItem.durationSeconds +
          combo.ctaItem.durationSeconds;
      }

      try {
        ManifestManager.appendItem(outputDir, manifest, combo.filename, outputItem);
      } catch (err) {
        this.writeRenderLog(
          productRoot,
          product.slug,
          combo.filename,
          "WARN",
          `Gagal menulis manifest DONE: ${(err as Error).message}`,
          ""
        );
      }

      job.done++;
      this.writeRenderLog(
        productRoot,
        product.slug,
        combo.filename,
        "DONE",
        `durasi=${outputItem.durationSeconds.toFixed(2)}s ukuran=${outputItem.sizeBytes}B`,
        ""
      );
      events?.onItemDone?.(combo.filename, outputItem, job.done, total);
      events?.onProgress?.(job.done, total, combo.filename);
    };

    const workerTask = async () => {
      while (remainingQueue.length > 0 && !this.isCancelled) {
        const item = remainingQueue.shift();
        if (item) {
          await renderSingle(item);
        }
        currentIndex++;
      }
    };

    try {
      const workerPromises = Array.from({ length: workers }, () => workerTask());
      await Promise.all(workerPromises);

      // Final flush
      try {
        ManifestManager.saveManifest(outputDir, manifest);
      } catch (err) {
        this.writeRenderLog(
          productRoot,
          product.slug,
          "(manifest)",
          "WARN",
          `Gagal menyimpan manifest: ${(err as Error).message}`,
          ""
        );
      }

      try {
        ReportGenerator.saveReport(outputDir, manifest, product);
      } catch (err) {
        this.writeRenderLog(
          productRoot,
          product.slug,
          "(report)",
          "WARN",
          `Gagal menyimpan report: ${(err as Error).message}`,
          ""
        );
      }

      if (this.isCancelled) {
        job.cancelled = true;
        job.status = "CANCELLED";
      } else if (job.failed > 0 && job.done === 0) {
        job.status = "FAILED";
      } else {
        job.status = "DONE";
      }
      job.completedAt = new Date().toISOString();
      return job;
    } catch (err) {
      job.cancelled = this.isCancelled || job.cancelled;
      if (this.isCancelled) {
        job.status = "CANCELLED";
      } else if (job.failed > 0 && job.done === 0) {
        job.status = "FAILED";
      } else {
        job.status = "DONE";
      }
      job.completedAt = new Date().toISOString();
      throw err;
    }
  }

  /**
   * Preflight: pastikan file cache normalized ada, valid MP4, dan bisa diprobe.
   * Hasil sukses di-cache per engine agar tidak probe file yang sama berulang kali.
   */
  private async preflightInputs(files: string[]): Promise<string | null> {
    for (const file of files) {
      if (this.validatedInputs.has(file)) continue;

      if (!fs.existsSync(file)) {
        return `Cache input tidak ditemukan: ${file}. Jalankan scan ulang sebelum render.`;
      }

      try {
        const stats = fs.statSync(file);
        if (stats.size === 0) {
          return `Cache input kosong (0 byte): ${file}. Jalankan scan ulang sebelum render.`;
        }
      } catch (err) {
        return `Cache input tidak dapat dibaca: ${file} (${(err as Error).message})`;
      }

      if (!ScanEngine.isValidMp4Magic(file)) {
        return `Cache input bukan MP4 valid (magic bytes mismatch): ${file}. Jalankan scan ulang sebelum render.`;
      }

      try {
        const probe = await VideoProbe.probeFile(file);
        if (!probe.videoStream || !probe.audioStream) {
          return `Cache input tidak memiliki stream video+audio: ${file}. Jalankan scan ulang sebelum render.`;
        }
      } catch (err) {
        return `Cache input gagal diprobe: ${file} (${(err as Error).message})`;
      }

      this.validatedInputs.add(file);
    }

    return null;
  }

  /**
   * Kill seluruh process tree. Di Windows taskkill /T /F menangani anak proses,
   * dengan fallback proc.kill() bila taskkill tidak tersedia.
   */
  private killProcessTree(proc: ChildProcess): void {
    if (!proc.pid) {
      try { proc.kill(); } catch {}
      return;
    }

    if (process.platform === "win32") {
      try {
        const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          try { proc.kill(); } catch {}
        });
        killer.unref();
        return;
      } catch {
        // fallback ke proc.kill() di bawah
      }
    }

    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  /**
   * Tulis log per item ke logs/<slug>/render-YYYYMMDD.log.
   * Rotasi sederhana ke .1 jika file > 10 MB. Gagal menulis log tidak boleh crash.
   */
  private writeRenderLog(
    productRoot: string,
    slug: string,
    filename: string,
    status: string,
    detail: string,
    stderrTail: string
  ): void {
    try {
      const logDir = path.join(productRoot, "logs", slug);
      fs.mkdirSync(logDir, { recursive: true });

      const logPath = path.join(logDir, `render-${formatLogDate(new Date())}.log`);
      try {
        if (fs.statSync(logPath).size > LOG_MAX_BYTES) {
          const rotatedPath = `${logPath}.1`;
          try { fs.rmSync(rotatedPath, { force: true }); } catch {}
          fs.renameSync(logPath, rotatedPath);
        }
      } catch {
        // file log belum ada
      }

      const lines = [`[${new Date().toISOString()}] ${status} ${filename}`, `  ${detail}`];
      const trimmedTail = stderrTail.trim();
      if (trimmedTail) {
        lines.push(
          ...trimmedTail
            .replace(/\r/g, "")
            .split("\n")
            .map((line) => `  stderr | ${line}`)
        );
      }

      fs.appendFileSync(logPath, lines.join("\n") + "\n", "utf-8");
    } catch {
      // logging bersifat best-effort
    }
  }

  private async atomicRenameWithRetry(src: string, dest: string): Promise<void> {
    const delays = [100, 300, 900, 2000];
    let lastErr: unknown;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        fs.renameSync(src, dest);
        return;
      } catch (err) {
        lastErr = err;
        const delay = delays[attempt];
        if (delay === undefined) break;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Jika gagal rename berulang kali, lempar error
    throw lastErr;
  }
}
