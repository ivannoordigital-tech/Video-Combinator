import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RenderEngine } from "../src/core/render.js";
import { ManifestManager } from "../src/core/manifest.js";
import { ProductConfigSchema, ProductConfig } from "../src/schemas/product.js";
import { AssetItem } from "../src/schemas/assets.js";
import { PlanCombination } from "../src/core/plan.js";
import { Job } from "../src/schemas/job.js";
import { Manifest } from "../src/schemas/manifest.js";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const tempRoots: string[] = [];

function makeTempRoot(name: string): string {
  const dir = path.join(ROOT_DIR, "cache", `swarm-render-${process.pid}-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempRoots.push(dir);
  return dir;
}

function makeProduct(): ProductConfig {
  return ProductConfigSchema.parse({
    slug: "swarm-render-test",
    displayName: "Swarm Render Test",
    createdAt: new Date().toISOString(),
  });
}

function makeAsset(slug: string, shaChar: string): AssetItem {
  return {
    slug,
    enabled: true,
    sha256: shaChar.repeat(64),
    sizeBytes: 1024,
    mtimeMs: Date.now(),
    durationSeconds: 2,
    origin: "scan",
    status: "READY",
    ingestedAt: new Date().toISOString(),
    error: null,
  };
}

function makeCombo(): PlanCombination {
  const hookItem = makeAsset("hook-01", "a");
  const bodyItem = makeAsset("body-01", "b");
  const ctaItem = makeAsset("cta-01", "c");

  return {
    key: "abcd1234",
    filename: "swarm-render-test__hook-01__body-01__cta-01__abcd1234.mp4",
    hookFile: "hook-01.mp4",
    bodyFile: "body-01.mp4",
    ctaFile: "cta-01.mp4",
    hookItem,
    bodyItem,
    ctaItem,
    status: "QUEUED",
  };
}

function makeJob(product: ProductConfig, total = 1): Job {
  return {
    jobId: `job_${Date.now()}`,
    product: product.slug,
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
  };
}

function makeManifest(product: ProductConfig): Manifest {
  return {
    schemaVersion: 1,
    product: product.slug,
    specHash: "test",
    updatedAt: new Date().toISOString(),
    tool: { app: "1.0.0", ffmpeg: "9.0" },
    outputs: {},
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RenderEngine cancel & preflight", () => {
  it("cancel sebelum render tidak menulis entri FAILED dan status CANCELLED", async () => {
    const productRoot = makeTempRoot("cancel");
    const product = makeProduct();
    const combo = makeCombo();
    const outputDir = path.join(productRoot, "output", product.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const job = makeJob(product);

    const engine = new RenderEngine();
    const completion = engine.completion;

    engine.cancel();
    const returned = await engine.renderQueue(productRoot, product, [combo], manifest, job);

    expect(returned).toBe(job);
    await expect(completion).resolves.toBe(job);

    expect(job.status).toBe("CANCELLED");
    expect(job.cancelled).toBe(true);
    expect(job.failed).toBe(0);
    expect(job.done).toBe(0);

    // Tidak ada entri manifest FAILED, baik di memori maupun di disk.
    expect(manifest.outputs).toEqual({});
    const saved = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf-8"));
    expect(saved.outputs).toEqual({});

    const jsonlPath = path.join(outputDir, "manifest.jsonl");
    if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(0);
    }

    // Tidak ada artefak .part / .list yang tertinggal.
    const partsDir = path.join(outputDir, ".parts");
    const leftovers = fs.existsSync(partsDir) ? fs.readdirSync(partsDir) : [];
    expect(leftovers).toHaveLength(0);

    // cancelAndWait pada engine yang sudah settle harus resolve cepat.
    await engine.cancelAndWait(1000);
  });

  it("preflight cache hilang menghasilkan FAILED dengan pesan jelas tanpa output", async () => {
    const productRoot = makeTempRoot("preflight");
    const product = makeProduct();
    const combo = makeCombo();
    const outputDir = path.join(productRoot, "output", product.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const job = makeJob(product);

    const failures: string[] = [];
    const engine = new RenderEngine();
    await engine.renderQueue(productRoot, product, [combo], manifest, job, {
      onItemFailed: (_filename, error) => failures.push(error),
    });

    expect(job.status).toBe("FAILED");
    expect(job.failed).toBe(1);
    expect(job.done).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Cache input tidak ditemukan");

    const manifestItem = manifest.outputs[combo.filename];
    expect(manifestItem?.status).toBe("FAILED");
    expect(manifestItem?.error).toContain("Cache input tidak ditemukan");

    // Tidak ada output final maupun part yang ditulis.
    expect(fs.existsSync(path.join(outputDir, combo.filename))).toBe(false);
    const partsDir = path.join(outputDir, ".parts");
    const leftovers = fs.existsSync(partsDir) ? fs.readdirSync(partsDir) : [];
    expect(leftovers).toHaveLength(0);

    // Log per item ditulis.
    const logDir = path.join(productRoot, "logs", product.slug);
    const logFiles = fs.readdirSync(logDir);
    expect(logFiles.some((f) => /^render-\d{8}\.log$/.test(f))).toBe(true);
    const logContent = logFiles
      .map((f) => fs.readFileSync(path.join(logDir, f), "utf-8"))
      .join("\n");
    expect(logContent).toContain("FAILED");
    expect(logContent).toContain("Cache input tidak ditemukan");
  });

  it("completion tetap resolve saat renderQueue throw di tahap setup", async () => {
    const productRoot = makeTempRoot("throw");
    const product = makeProduct();
    const job = makeJob(product, 0);
    const manifest = makeManifest(product);

    // Halangi pembuatan folder output/<slug> dengan sebuah file.
    const outputDir = path.join(productRoot, "output", product.slug);
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.writeFileSync(outputDir, "blocker", "utf-8");

    const engine = new RenderEngine();
    const completion = engine.completion;

    await expect(engine.renderQueue(productRoot, product, [], manifest, job)).rejects.toThrow();
    await expect(completion).resolves.toBe(job);
    expect(job.status).toBe("FAILED");
  });

  it("cancelAndWait dengan batas waktu tidak menggantung jika renderQueue tidak pernah dipanggil", async () => {
    const engine = new RenderEngine();
    const startedAt = Date.now();
    await engine.cancelAndWait(50);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
