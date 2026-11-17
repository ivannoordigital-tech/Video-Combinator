import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { VideoProbe } from "../src/core/probe.js";
import { NamingUtils } from "../src/core/naming.js";
import { ScanEngine } from "../src/core/scan.js";
import { PlanEngine } from "../src/core/plan.js";
import { RenderEngine } from "../src/core/render.js";
import { ManifestManager } from "../src/core/manifest.js";
import { ReportGenerator } from "../src/core/report.js";
import { ProductConfigSchema } from "../src/schemas/product.js";
import { AssetsRegistrySchema } from "../src/schemas/assets.js";
import { Job } from "../src/schemas/job.js";

describe("Fase 1: Core Engine Integration Suite", () => {
  const ROOT_DIR = path.resolve(import.meta.dirname, "..");
  const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures");
  const TEST_ROOT = path.join(ROOT_DIR, "cache", "test_core_e2e");

  const product = ProductConfigSchema.parse({
    slug: "sepatu-kulit",
    displayName: "Sepatu Kulit",
    createdAt: new Date().toISOString(),
  });

  beforeAll(() => {
    fs.mkdirSync(path.join(TEST_ROOT, "database", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "database", "bodies"), { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "database", "ctas"), { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "cache"), { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "output"), { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "state"), { recursive: true });

    // Copy fixture baseline clips: hook.mp4, body.mp4, cta.mp4
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "01_baseline", "hook.mp4"),
      path.join(TEST_ROOT, "database", "hooks", "hook-01.mp4")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "01_baseline", "body.mp4"),
      path.join(TEST_ROOT, "database", "bodies", "body-01.mp4")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "01_baseline", "cta.mp4"),
      path.join(TEST_ROOT, "database", "ctas", "cta-01.mp4")
    );
  });

  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("T1.5: Slug & Naming - harus menghasilkan slug ASCII aman & hash8", () => {
    const slug = NamingUtils.toSlug("PRODUK Diskon 50% & Hadiah! 👍.mp4");
    expect(slug).toBe("produk-diskon-50-hadiah");

    const reserved = NamingUtils.toSlug("CON.mp4");
    expect(reserved).toBe("con-clip");

    const hash8 = NamingUtils.computeHash8("sepatu", "h1.mp4", "b1.mp4", "c1.mp4");
    expect(hash8).toHaveLength(8);

    const filename = NamingUtils.formatOutputFilename("sepatu", "hook-1", "body-1", "cta-1", hash8);
    expect(filename).toBe(`sepatu__hook-1__body-1__cta-1__${hash8}.mp4`);
  });

  it("T1.6: Scan & Ingest - memindai folder database dan menormalisasi aset", async () => {
    let registry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "init",
      assets: { hook: {}, body: {}, cta: {} },
    });

    registry = await ScanEngine.scanProductAssets(TEST_ROOT, product, registry);

    expect(Object.keys(registry.assets.hook)).toHaveLength(1);
    expect(Object.keys(registry.assets.body)).toHaveLength(1);
    expect(Object.keys(registry.assets.cta)).toHaveLength(1);

    const hookItem = registry.assets.hook["hook-01.mp4"];
    expect(hookItem?.status).toBe("READY");
    expect(hookItem?.durationSeconds).toBeGreaterThan(1.8);
  });

  it("T1.7: Plan - menghitung kombinasi dan mendeteksi antrean baru", async () => {
    let registry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "init",
      assets: { hook: {}, body: {}, cta: {} },
    });
    registry = await ScanEngine.scanProductAssets(TEST_ROOT, product, registry);

    const outputDir = path.join(TEST_ROOT, "output");
    const manifest = ManifestManager.loadManifest(outputDir, product);

    const plan = await PlanEngine.createPlan(TEST_ROOT, product, registry, manifest, "new");
    expect(plan.counts.total).toBe(1); // 1x1x1
    expect(plan.counts.queued).toBe(1);
    expect(plan.counts.done).toBe(0);
    expect(plan.queue).toHaveLength(1);
  });

  it("T1.8 & T1.9: Render & Verify - menggabungkan video secara lossless dan atomik", async () => {
    let registry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "init",
      assets: { hook: {}, body: {}, cta: {} },
    });
    registry = await ScanEngine.scanProductAssets(TEST_ROOT, product, registry);

    const outputDir = path.join(TEST_ROOT, "output");
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const plan = await PlanEngine.createPlan(TEST_ROOT, product, registry, manifest, "new");

    const job: Job = {
      jobId: "test_job_1",
      product: product.slug,
      status: "RUNNING",
      scope: "new",
      total: plan.counts.queued,
      done: 0,
      failed: 0,
      skipped: 0,
      current: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      etaSeconds: 1,
      cancelled: false,
    };

    const renderEngine = new RenderEngine();
    await renderEngine.renderQueue(TEST_ROOT, product, plan.queue, manifest, job);

    expect(job.status).toBe("DONE");
    expect(job.done).toBe(1);
    expect(job.failed).toBe(0);

    const finalFile = path.join(outputDir, plan.queue[0]!.filename);
    expect(fs.existsSync(finalFile)).toBe(true);

    const probe = await VideoProbe.probeFile(finalFile);
    expect(probe.videoStream?.width).toBe(1080);
    expect(probe.videoStream?.height).toBe(1920);
    expect(probe.audioStream?.channels).toBe(2);
    // 3 klip @ 2s = ~6s
    expect(probe.durationSeconds).toBeGreaterThan(5.5);
    expect(probe.durationSeconds).toBeLessThan(6.5);
  });

  it("T1.7 Incremental Idempotency: Scan & Plan ulang harus men-SKIP video yang sudah DONE", async () => {
    let registry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "init",
      assets: { hook: {}, body: {}, cta: {} },
    });
    registry = await ScanEngine.scanProductAssets(TEST_ROOT, product, registry);

    const outputDir = path.join(TEST_ROOT, "output");
    const manifest = ManifestManager.loadManifest(outputDir, product);

    const plan = await PlanEngine.createPlan(TEST_ROOT, product, registry, manifest, "new");
    expect(plan.counts.total).toBe(1);
    expect(plan.counts.done).toBe(1);
    expect(plan.counts.queued).toBe(0); // 0 RENDER!
  });

  it("T1.11: Report - menghasilkan CSV UTF-8 dengan BOM dan CRLF", () => {
    const outputDir = path.join(TEST_ROOT, "output");
    const manifest = ManifestManager.loadManifest(outputDir, product);

    const reportPath = ReportGenerator.saveReport(outputDir, manifest, product);
    expect(fs.existsSync(reportPath)).toBe(true);

    const buffer = fs.readFileSync(reportPath);
    // Check UTF-8 BOM: EF BB BF
    expect(buffer[0]).toBe(0xef);
    expect(buffer[1]).toBe(0xbb);
    expect(buffer[2]).toBe(0xbf);

    const content = buffer.toString("utf-8");
    expect(content).toContain("\r\n");
    expect(content).toContain("sepatu-kulit");
    expect(content).toContain("DONE");
  });
});
