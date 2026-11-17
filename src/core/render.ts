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

export interface RenderEvents {
  onItemDone?: (filename: string, item: OutputItem, index: number, total: number) => void;
  onItemFailed?: (filename: string, error: string, index: number, total: number) => void;
  onProgress?: (done: number, total: number, current: string) => void;
}

export class RenderEngine {
  private activeProcesses = new Set<ChildProcess>();
  private isCancelled = false;

  public cancel(): void {
    this.isCancelled = true;
    for (const proc of this.activeProcesses) {
      try {
        if (proc.pid) {
          process.kill(proc.pid);
        }
      } catch {
        // ignore
      }
    }
    this.activeProcesses.clear();
  }

  public async renderQueue(
    productRoot: string,
    product: ProductConfig,
    queue: PlanCombination[],
    manifest: Manifest,
    job: Job,
    events?: RenderEvents
  ): Promise<Job> {
    const outputDir = path.join(productRoot, "output");
    const partsDir = path.join(outputDir, ".parts");
    const cacheDir = path.join(productRoot, "cache", "ingest");
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

    const renderSingle = async (combo: PlanCombination): Promise<void> => {
      if (this.isCancelled) return;

      const hookNormalized = path.join(cacheDir, `${combo.hookItem.sha256.slice(0, 8)}__${combo.hookItem.slug}.mp4`);
      const bodyNormalized = path.join(cacheDir, `${combo.bodyItem.sha256.slice(0, 8)}__${combo.bodyItem.slug}.mp4`);
      const ctaNormalized = path.join(cacheDir, `${combo.ctaItem.sha256.slice(0, 8)}__${combo.ctaItem.slug}.mp4`);

      const listFile = path.join(partsDir, `${combo.key}.list`);
      const partFile = path.join(partsDir, `${combo.key}.part`);
      const finalFile = path.join(outputDir, combo.filename);

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

      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
          this.activeProcesses.add(proc);

          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("Render timeout (120s)"));
          }, 120000);

          proc.on("close", (code) => {
            clearTimeout(timeout);
            this.activeProcesses.delete(proc);
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exit with code ${code}`));
          });

          proc.on("error", (err) => {
            clearTimeout(timeout);
            this.activeProcesses.delete(proc);
            reject(err);
          });
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

        // Rename atomik dengan retry untuk Windows file locks (100, 300, 900, 2000 ms)
        await this.atomicRenameWithRetry(partFile, finalFile);

        // Hapus file list
        if (fs.existsSync(listFile)) {
          fs.unlinkSync(listFile);
        }

        // Catat ke manifest
        const outputItem: OutputItem = {
          key: combo.key,
          hook: combo.hookFile,
          body: combo.bodyFile,
          cta: combo.ctaFile,
          status: "DONE",
          durationSeconds: verifyRes.durationSeconds,
          sizeBytes: verifyRes.sizeBytes,
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

        ManifestManager.appendItem(outputDir, manifest, combo.filename, outputItem);
        job.done++;
        events?.onItemDone?.(combo.filename, outputItem, job.done, total);
      } catch (err) {
        if (fs.existsSync(partFile)) {
          try { fs.unlinkSync(partFile); } catch {}
        }
        if (fs.existsSync(listFile)) {
          try { fs.unlinkSync(listFile); } catch {}
        }

        job.failed++;
        const errorMessage = (err as Error).message;
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
        ManifestManager.appendItem(outputDir, manifest, combo.filename, failedItem);
      }

      currentIndex++;
      events?.onProgress?.(job.done, total, combo.filename);
    };

    const workerTask = async () => {
      while (remainingQueue.length > 0 && !this.isCancelled) {
        const item = remainingQueue.shift();
        if (item) {
          await renderSingle(item);
        }
      }
    };

    const workerPromises = Array.from({ length: workers }, () => workerTask());
    await Promise.all(workerPromises);

    // Final flush
    ManifestManager.saveManifest(outputDir, manifest);
    ReportGenerator.saveReport(outputDir, manifest, product);

    job.status = this.isCancelled ? "CANCELLED" : job.failed > 0 && job.done === 0 ? "FAILED" : "DONE";
    job.completedAt = new Date().toISOString();
    return job;
  }

  private async atomicRenameWithRetry(src: string, dest: string): Promise<void> {
    const delays = [100, 300, 900, 2000];
    let lastErr: unknown;

    for (const delay of delays) {
      try {
        fs.renameSync(src, dest);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Jika gagal rename berulang kali, lempar error
    throw lastErr;
  }
}
