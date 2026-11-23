import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ScanEngine } from "../src/core/scan.js";
import { PlanEngine } from "../src/core/plan.js";
import { RenderEngine } from "../src/core/render.js";
import { ManifestManager } from "../src/core/manifest.js";
import { IngestEngine } from "../src/core/ingest.js";
import { VideoProbe } from "../src/core/probe.js";
import { FFmpegResolver } from "../src/core/ffmpeg.js";
import { ProductConfigSchema, computeMusicConfigHash, type ProductConfig } from "../src/schemas/product.js";
import { AssetsRegistrySchema, type AssetsRegistry, type AssetItem } from "../src/schemas/assets.js";
import type { Job } from "../src/schemas/job.js";

describe("Backsound Opsi A: scan, plan, mix", () => {
  const ROOT_DIR = path.resolve(import.meta.dirname, "..");
  const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures", "01_baseline");
  const TEST_ROOT = path.join(
    ROOT_DIR,
    "cache",
    `swarm-music-${Math.random().toString(36).slice(2, 10)}`
  );
  const product = ProductConfigSchema.parse({
    slug: "swarm-music",
    displayName: "Swarm Music",
    createdAt: new Date().toISOString(),
  });
  const outputDir = path.join(TEST_ROOT, "output", product.slug);

  let registry: AssetsRegistry;

  function asset(slug: string, sha: string, durationSeconds = 2): AssetItem {
    return {
      slug,
      enabled: true,
      sha256: sha.repeat(64),
      sizeBytes: 1024,
      mtimeMs: Date.now(),
      durationSeconds,
      origin: "scan",
      status: "READY",
      ingestedAt: new Date().toISOString(),
      error: null,
    };
  }

  beforeAll(async () => {
    for (const dir of ["hooks", "bodies", "ctas", "backsounds"]) {
      fs.mkdirSync(path.join(TEST_ROOT, "database", product.slug, dir), { recursive: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(TEST_ROOT, "cache"), { recursive: true });

    for (const [folder, file] of [
      ["hooks", "hook.mp4"],
      ["bodies", "body.mp4"],
      ["ctas", "cta.mp4"],
    ] as const) {
      fs.copyFileSync(
        path.join(FIXTURES_DIR, file),
        path.join(TEST_ROOT, "database", product.slug, folder, file)
      );
    }

    for (const [name, frequency] of [["music-a.wav", 440], ["music-b.wav", 660]] as const) {
      await FFmpegResolver.executeFfmpeg([
        "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=44100`,
        "-t", "3", "-ac", "1", "-c:a", "pcm_s16le",
        path.join(TEST_ROOT, "database", product.slug, "backsounds", name),
      ]);
    }

    registry = await ScanEngine.scanProductAssets(
      TEST_ROOT,
      product,
      AssetsRegistrySchema.parse({
        schemaVersion: 1,
        specHash: "init",
        assets: { hook: {}, body: {}, cta: {}, music: {} },
      })
    );
  });

  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("memindai backsound audio, menormalisasi ke AAC 48k stereo, dan membuat cache", async () => {
    expect(Object.keys(registry.assets.music)).toHaveLength(2);

    const item = registry.assets.music["music-a.wav"];
    expect(item).toBeDefined();
    expect(item!.status).toBe("READY");
    expect(item!.durationSeconds).toBeGreaterThan(2.5);

    const cachePath = IngestEngine.getMusicCachePath(
      TEST_ROOT,
      product,
      item!.sha256,
      item!.slug
    );
    expect(fs.existsSync(cachePath)).toBe(true);

    const probe = await VideoProbe.probeAudioFile(cachePath);
    expect(probe.audioStream?.codec_name).toBe("aac");
    expect(Number(probe.audioStream?.sample_rate)).toBe(48000);
    expect(probe.audioStream?.channels).toBe(2);
  }, 120_000);

  it("rotasi backsound menghasilkan track berbeda per output pada plan", async () => {
    const rotationRegistry = AssetsRegistrySchema.parse({
      schemaVersion: 1,
      specHash: "test",
      assets: {
        hook: { "h1.mp4": asset("h1", "a"), "h2.mp4": asset("h2", "b") },
        body: { "b1.mp4": asset("b1", "c") },
        cta: { "c1.mp4": asset("c1", "d") },
        music: { "m1.wav": asset("m1", "e", 3), "m2.wav": asset("m2", "f", 3) },
      },
    });
    const emptyManifest = ManifestManager.loadManifest(outputDir, product);
    const plan = await PlanEngine.createPlan(
      TEST_ROOT,
      product,
      rotationRegistry,
      emptyManifest,
      "new"
    );

    expect(plan.counts.music).toBe(2);
    expect(plan.queue).toHaveLength(2);
    expect(plan.queue[0]!.musicFile).toBe("m1.wav");
    expect(plan.queue[1]!.musicFile).toBe("m2.wav");
  }, 120_000);

  it("render mencampur backsound, video tetap ada, audio AAC 48k stereo, manifest mencatat track", async () => {
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const plan = await PlanEngine.createPlan(TEST_ROOT, product, registry, manifest, "new");

    expect(plan.counts.music).toBe(2);
    expect(plan.queue).toHaveLength(1);
    expect(plan.queue[0]!.musicFile).toBeTruthy();

    const job: Job = {
      jobId: "music_test_job",
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

    const engine = new RenderEngine();
    await engine.renderQueue(TEST_ROOT, product, plan.queue, manifest, job);

    expect(job.status).toBe("DONE");
    expect(job.done).toBe(1);
    expect(job.failed).toBe(0);

    const filename = plan.queue[0]!.filename;
    const finalFile = path.join(outputDir, filename);
    expect(fs.existsSync(finalFile)).toBe(true);

    const probe = await VideoProbe.probeFile(finalFile);
    expect(probe.videoStream?.width).toBe(1080);
    expect(probe.videoStream?.height).toBe(1920);
    expect(probe.audioStream?.codec_name).toBe("aac");
    expect(Number(probe.audioStream?.sample_rate)).toBe(48000);
    expect(probe.audioStream?.channels).toBe(2);
    expect(probe.durationSeconds).toBeGreaterThan(5.5);
    expect(probe.durationSeconds).toBeLessThan(6.5);

    const output = manifest.outputs[filename];
    expect(output).toBeDefined();
    expect(output!.status).toBe("DONE");
    expect(output!.music).toBe(plan.queue[0]!.musicFile);
    expect(output!.musicFingerprint).toBe(plan.queue[0]!.musicItem!.sha256);
    expect(output!.musicConfigHash).toBe(computeMusicConfigHash(product.music));

    // Plan berikutnya tidak boleh mengulang output yang sudah punya backsound valid.
    const nextPlan = await PlanEngine.createPlan(TEST_ROOT, product, registry, manifest, "all");
    expect(nextPlan.counts.done).toBe(1);
    expect(nextPlan.counts.queued).toBe(0);
  }, 180_000);

  it("render preview menghasilkan satu video contoh tanpa menyentuh manifest", async () => {
    const hook = Object.entries(registry.assets.hook)[0]!;
    const body = Object.entries(registry.assets.body)[0]!;
    const cta = Object.entries(registry.assets.cta)[0]!;
    const music = Object.entries(registry.assets.music)[0]!;
    const previewPath = path.join(TEST_ROOT, "cache", product.slug, "preview", "preview.mp4");

    const previewProduct = ProductConfigSchema.parse({
      ...product,
      music: {
        ...product.music,
        volume: 0.12,
        tracks: {
          [music[0]]: { volume: 0.35, startSeconds: 0.5, endSeconds: 1.5 },
        },
      },
    });
    expect(computeMusicConfigHash(previewProduct.music)).not.toBe(
      computeMusicConfigHash(product.music)
    );

    const result = await new RenderEngine().renderPreview(
      TEST_ROOT,
      previewProduct,
      {
        key: "preview",
        filename: "preview.mp4",
        hookFile: hook[0],
        bodyFile: body[0],
        ctaFile: cta[0],
        hookItem: hook[1],
        bodyItem: body[1],
        ctaItem: cta[1],
        status: "QUEUED",
        musicFile: music[0],
        musicItem: music[1],
      },
      previewPath
    );

    expect(fs.existsSync(previewPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(50_000);
    const probe = await VideoProbe.probeFile(previewPath);
    expect(probe.videoStream?.width).toBe(1080);
    expect(probe.audioStream?.codec_name).toBe("aac");
    expect(probe.durationSeconds).toBeGreaterThan(5.5);
  }, 180_000);
});
