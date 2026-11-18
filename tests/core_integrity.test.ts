import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ScanEngine } from "../src/core/scan.js";
import { IngestEngine } from "../src/core/ingest.js";
import { PlanEngine, clearPlanVerificationCache } from "../src/core/plan.js";
import { RenderEngine } from "../src/core/render.js";
import { ManifestManager } from "../src/core/manifest.js";
import { OutputVerifier } from "../src/core/verify.js";
import { VideoProbe } from "../src/core/probe.js";
import { FFmpegResolver } from "../src/core/ffmpeg.js";
import {
  ProductConfigSchema,
  computeSpecHash,
  type ProductConfig,
} from "../src/schemas/product.js";
import { AssetsRegistrySchema, type AssetsRegistry } from "../src/schemas/assets.js";
import type { Job } from "../src/schemas/job.js";
import type { Manifest } from "../src/schemas/manifest.js";

/**
 * Regresi integritas core: R1.4 (invalidasi cache ingest), R1.5 (integritas DONE),
 * R2.9 (verifier/probe), R2.6 (orphan + retry FAILED).
 */
describe("Core Integrity Suite (R1.4/R1.5/R2.9/R2.6)", () => {
  const ROOT_DIR = path.resolve(import.meta.dirname, "..");
  const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures", "01_baseline");
  const TEST_ROOT = path.join(
    ROOT_DIR,
    "cache",
    `swarm-core-${Math.random().toString(36).slice(2, 10)}`
  );

  const baseProduct = ProductConfigSchema.parse({
    slug: "swarm-core",
    displayName: "Swarm Core",
    createdAt: new Date().toISOString(),
  });

  const productCrf18: ProductConfig = baseProduct;
  const productCrf28: ProductConfig = ProductConfigSchema.parse({
    ...baseProduct,
    video: { ...baseProduct.video, crf: 28 },
  });

  const specHash18 = computeSpecHash(productCrf18.video, productCrf18.audio);
  const specHash28 = computeSpecHash(productCrf28.video, productCrf28.audio);

  const cacheDir = path.join(TEST_ROOT, "cache", baseProduct.slug);
  const outputDir = path.join(TEST_ROOT, "output", baseProduct.slug);

  let registry18: AssetsRegistry;
  let registry28: AssetsRegistry;
  let outputFilename = "";

  const loadManifest = (): Manifest => ManifestManager.loadManifest(outputDir, productCrf28);

  const createJob = (total: number): Job => ({
    jobId: `swarm_core_${Date.now()}`,
    product: baseProduct.slug,
    status: "RUNNING",
    scope: "new",
    total,
    done: 0,
    failed: 0,
    skipped: 0,
    current: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    etaSeconds: 1,
    cancelled: false,
  });

  beforeAll(() => {
    for (const folder of ["hooks", "bodies", "ctas"]) {
      fs.mkdirSync(path.join(TEST_ROOT, "database", baseProduct.slug, folder), { recursive: true });
    }
    fs.mkdirSync(path.join(TEST_ROOT, "cache"), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    fs.copyFileSync(path.join(FIXTURES_DIR, "hook.mp4"), path.join(TEST_ROOT, "database", baseProduct.slug, "hooks", "hook-01.mp4"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "body.mp4"), path.join(TEST_ROOT, "database", baseProduct.slug, "bodies", "body-01.mp4"));
    fs.copyFileSync(path.join(FIXTURES_DIR, "cta.mp4"), path.join(TEST_ROOT, "database", baseProduct.slug, "ctas", "cta-01.mp4"));
  }, 120_000);

  afterAll(() => {
    clearPlanVerificationCache();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("(a) perubahan CRF 18 -> 28 menghasilkan cache ingest baru dan tidak memakai cache lama", async () => {
    const emptyRegistry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "init",
      assets: { hook: {}, body: {}, cta: {} },
    });

    registry18 = await ScanEngine.scanProductAssets(TEST_ROOT, productCrf18, emptyRegistry);
    expect(specHash18).not.toBe(specHash28);

    const hook18 = registry18.assets.hook["hook-01.mp4"]!;
    expect(hook18.status).toBe("READY");

    const cachePath18 = IngestEngine.normalizedCachePath(cacheDir, hook18.sha256, hook18.slug, specHash18);
    expect(fs.existsSync(cachePath18)).toBe(true);
    expect(path.basename(cachePath18)).toBe(
      `${hook18.sha256.slice(0, 8)}__${specHash18.slice(0, 8)}__${hook18.slug}.mp4`
    );

    registry28 = await ScanEngine.scanProductAssets(TEST_ROOT, productCrf28, registry18);
    const hook28 = registry28.assets.hook["hook-01.mp4"]!;
    expect(hook28.status).toBe("READY");
    expect(hook28.sha256).toBe(hook18.sha256);

    const cachePath28 = IngestEngine.normalizedCachePath(cacheDir, hook28.sha256, hook28.slug, specHash28);
    expect(cachePath28).not.toBe(cachePath18);
    expect(fs.existsSync(cachePath28)).toBe(true);

    // Cache spesifikasi lama dibersihkan, bukan dipakai ulang.
    expect(fs.existsSync(cachePath18)).toBe(false);

    // Scan ulang dengan spec yang sama harus hit cache (file tidak ditulis ulang).
    const mtimeBefore = fs.statSync(cachePath28).mtimeMs;
    const registry28Again = await ScanEngine.scanProductAssets(TEST_ROOT, productCrf28, registry28);
    expect(registry28Again.assets.hook["hook-01.mp4"]!.status).toBe("READY");
    expect(fs.statSync(cachePath28).mtimeMs).toBe(mtimeBefore);
  }, 180_000);

  it("(c) output valid dihitung DONE dan tidak masuk antrean", async () => {
    clearPlanVerificationCache();

    const manifest = loadManifest();
    const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, manifest, "new");
    expect(plan.counts.total).toBe(1);
    expect(plan.counts.queued).toBe(1);
    expect(plan.counts.done).toBe(0);

    outputFilename = plan.queue[0]!.filename;

    const job = createJob(plan.queue.length);
    const renderEngine = new RenderEngine();
    await renderEngine.renderQueue(TEST_ROOT, productCrf28, plan.queue, manifest, job);

    expect(job.status).toBe("DONE");
    expect(job.done).toBe(1);
    expect(job.failed).toBe(0);

    const outputPath = path.join(outputDir, outputFilename);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThanOrEqual(50 * 1024);

    // Durasi NaN harus ditolak verifier.
    const nanResult = await OutputVerifier.verifyOutput(outputPath, Number.NaN, productCrf28);
    expect(nanResult.valid).toBe(false);
    expect(nanResult.error).toMatch(/durasi/i);

    clearPlanVerificationCache();
    const planAgain = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, loadManifest(), "new");
    expect(planAgain.counts.done).toBe(1);
    expect(planAgain.counts.queued).toBe(0);
    expect(planAgain.queue).toHaveLength(0);
    expect(planAgain.counts.orphan).toBe(0);
  }, 180_000);

  it("(d) output ter-truncate dengan manifest DONE harus QUEUED, bukan DONE", async () => {
    const outputPath = path.join(outputDir, outputFilename);
    const full = fs.readFileSync(outputPath);
    const truncated = full.subarray(0, Math.floor(full.length * 0.6));
    fs.writeFileSync(outputPath, truncated);

    // Pastikan file masih > 50 KB sehingga yang diuji benar-benar deteksi truncation.
    expect(fs.statSync(outputPath).size).toBeGreaterThanOrEqual(50 * 1024);
    const probe = await VideoProbe.probeFile(outputPath);
    expect(probe.videoStream).not.toBeNull();

    clearPlanVerificationCache();
    const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, loadManifest(), "new");

    expect(plan.counts.done).toBe(0);
    const combo = plan.queue.find((item) => item.filename === outputFilename);
    expect(combo).toBeDefined();
    expect(combo!.status).toBe("QUEUED");
    expect(combo!.reason).toMatch(/verifikasi/i);
  }, 120_000);

  it("(b) file 20 KB berisi nol dengan manifest DONE harus QUEUED", async () => {
    const outputPath = path.join(outputDir, outputFilename);
    fs.writeFileSync(outputPath, Buffer.alloc(20 * 1024, 0));

    clearPlanVerificationCache();
    const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, loadManifest(), "new");

    expect(plan.counts.done).toBe(0);
    expect(plan.counts.queued).toBe(1);
    const combo = plan.queue.find((item) => item.filename === outputFilename);
    expect(combo).toBeDefined();
    expect(combo!.status).toBe("QUEUED");
    expect(combo!.reason).toMatch(/kecil/i);
  }, 120_000);

  it("(f) output DONE yang kombinasinya tidak ada di cartesian aktif dihitung orphan", async () => {
    const manifest = loadManifest();
    const template = manifest.outputs[outputFilename]!;
    const ghostFilename = "swarm-core__ghost-hook__ghost-body__ghost-cta__deadbeef.mp4";

    manifest.outputs[ghostFilename] = {
      ...template,
      key: "deadbeef",
      hook: "ghost-hook.mp4",
      body: "ghost-body.mp4",
      cta: "ghost-cta.mp4",
      status: "DONE",
      durationSeconds: 6,
      sizeBytes: 123456,
      error: null,
      verified: true,
    };

    clearPlanVerificationCache();
    const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, manifest, "all");

    expect(plan.counts.orphan).toBe(1);
    // Entri ghost tidak boleh menambah counts.done karena asetnya tidak ada.
    expect(plan.counts.done).toBe(0);
  }, 120_000);

  it("(g) entri FAILED tetap di-retry pada scope=new meski ketiga aset sudah dipakai output DONE lain", async () => {
    const manifest = loadManifest();
    const current = manifest.outputs[outputFilename]!;

    // Output DONE historis yang memakai ketiga aset yang sama.
    const legacyFilename = "swarm-core__legacy__run__output__aaaaaaaa.mp4";
    manifest.outputs[legacyFilename] = {
      ...current,
      key: "aaaaaaaa",
      status: "DONE",
      durationSeconds: 6,
      sizeBytes: 123456,
      error: null,
      verified: true,
    };

    // Kombinasi yang sama tercatat FAILED pada manifest.
    manifest.outputs[outputFilename] = {
      ...current,
      status: "FAILED",
      durationSeconds: 0,
      sizeBytes: 0,
      verified: false,
      error: "render timeout",
    };

    clearPlanVerificationCache();
    const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, manifest, "new");

    const combo = plan.queue.find((item) => item.filename === outputFilename);
    expect(combo).toBeDefined();
    expect(combo!.status).toBe("QUEUED");
    expect(combo!.reason).toMatch(/gagal/i);
    expect(plan.counts.queued).toBe(1);
  }, 120_000);

  it("(e) verifier mengizinkan selisih fps 5 tetapi menolak selisih 6", async () => {
    const scratchDir = path.join(TEST_ROOT, "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const fps25Path = path.join(scratchDir, "fps25.mp4");

    await FFmpegResolver.executeFfmpeg([
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", path.join(FIXTURES_DIR, "hook.mp4"),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      "-t", "2", "-movflags", "+faststart", "-f", "mp4", fps25Path,
    ]);

    expect(fs.statSync(fps25Path).size).toBeGreaterThanOrEqual(50 * 1024);

    const probe = await VideoProbe.probeFile(fps25Path);
    expect(probe.fps).toBe(25);
    expect(probe.audioStream?.channels).toBe(2);

    // 25 fps vs target 30 fps: selisih 5, masih dalam toleransi.
    const allowed = await OutputVerifier.verifyOutput(fps25Path, 2, productCrf28);
    expect(allowed.valid).toBe(true);

    // 25 fps vs target 19 fps: selisih 6, harus ditolak.
    const productFps19 = ProductConfigSchema.parse({
      ...productCrf28,
      video: { ...productCrf28.video, fps: 19 },
    });
    const rejected = await OutputVerifier.verifyOutput(fps25Path, 2, productFps19);
    expect(rejected.valid).toBe(false);
    expect(rejected.error).toMatch(/frame rate|fps/i);
  }, 120_000);

  it("(h) fast-path verified=true tidak memanggil ffprobe, file ter-truncate tetap QUEUED", async () => {
    const outputPath = path.join(outputDir, outputFilename);

    // Pulihkan output valid (file saat ini 20 KB nol dari kasus b).
    clearPlanVerificationCache();
    const recoveryManifest = loadManifest();
    const recoveryPlan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, recoveryManifest, "new");
    expect(recoveryPlan.queue.map((item) => item.filename)).toContain(outputFilename);

    const job = createJob(recoveryPlan.queue.length);
    await new RenderEngine().renderQueue(TEST_ROOT, productCrf28, recoveryPlan.queue, recoveryManifest, job);
    expect(job.done).toBe(1);

    clearPlanVerificationCache();
    const manifest = loadManifest();
    expect(manifest.outputs[outputFilename]!.verified).toBe(true);

    // 1) Fast-path: plan tidak boleh memanggil ffprobe sama sekali.
    const fastSpy = vi.spyOn(OutputVerifier, "verifyOutput");
    try {
      const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, manifest, "new");
      expect(fastSpy).not.toHaveBeenCalled();
      expect(plan.counts.done).toBe(1);
      expect(plan.counts.queued).toBe(0);
    } finally {
      fastSpy.mockRestore();
    }

    // 2) Truncate -> mtime/ukuran berubah -> verifikasi penuh -> box check gagal -> QUEUED.
    const full = fs.readFileSync(outputPath);
    fs.writeFileSync(outputPath, full.subarray(0, Math.floor(full.length * 0.6)));
    expect(fs.statSync(outputPath).size).toBeGreaterThanOrEqual(50 * 1024);

    const slowSpy = vi.spyOn(OutputVerifier, "verifyOutput");
    try {
      const plan = await PlanEngine.createPlan(TEST_ROOT, productCrf28, registry28, loadManifest(), "new");
      expect(slowSpy).toHaveBeenCalled();
      expect(plan.counts.done).toBe(0);
      const combo = plan.queue.find((item) => item.filename === outputFilename);
      expect(combo).toBeDefined();
      expect(combo!.status).toBe("QUEUED");
    } finally {
      slowSpy.mockRestore();
    }
  }, 120_000);
});
