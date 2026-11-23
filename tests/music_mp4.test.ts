import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ScanEngine } from "../src/core/scan.js";
import { IngestEngine } from "../src/core/ingest.js";
import { VideoProbe } from "../src/core/probe.js";
import { FFmpegResolver } from "../src/core/ffmpeg.js";
import { ProductConfigSchema } from "../src/schemas/product.js";
import { AssetsRegistrySchema, type AssetsRegistry } from "../src/schemas/assets.js";

describe("Backsound berformat .mp4", () => {
  const ROOT_DIR = path.resolve(import.meta.dirname, "..");
  const TEST_ROOT = path.join(
    ROOT_DIR,
    "cache",
    `swarm-music-mp4-${Math.random().toString(36).slice(2, 10)}`
  );
  const product = ProductConfigSchema.parse({
    slug: "swarm-music-mp4",
    displayName: "Swarm Music MP4",
    createdAt: new Date().toISOString(),
  });
  const backsoundsDir = path.join(TEST_ROOT, "database", product.slug, "backsounds");

  let registry: AssetsRegistry;

  beforeAll(async () => {
    for (const dir of ["hooks", "bodies", "ctas", "backsounds"]) {
      fs.mkdirSync(path.join(TEST_ROOT, "database", product.slug, dir), { recursive: true });
    }
    fs.mkdirSync(path.join(TEST_ROOT, "cache"), { recursive: true });

    // Audio-only MP4 (kontainer MP4, tanpa stream video) seperti hasil unduhan.
    await FFmpegResolver.executeFfmpeg([
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "2", "-ac", "1", "-c:a", "aac",
      "-f", "mp4",
      path.join(backsoundsDir, "music-mp4.mp4"),
    ]);

    registry = await ScanEngine.scanProductAssets(
      TEST_ROOT,
      product,
      AssetsRegistrySchema.parse({
        schemaVersion: 1,
        specHash: "init",
        assets: { hook: {}, body: {}, cta: {}, music: {} },
      })
    );
  }, 120_000);

  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("menerima .mp4 di folder backsounds dan menormalisasinya ke AAC", async () => {
    const item = registry.assets.music["music-mp4.mp4"];
    expect(item).toBeDefined();
    expect(item!.status).toBe("READY");

    const cachePath = IngestEngine.getMusicCachePath(
      TEST_ROOT,
      product,
      item!.sha256,
      item!.slug
    );
    expect(fs.existsSync(cachePath)).toBe(true);

    const probe = await VideoProbe.probeAudioFile(cachePath);
    expect(probe.audioStream?.codec_name).toBe("aac");
    expect(probe.videoStream).toBeNull();
    expect(Number(probe.audioStream?.sample_rate)).toBe(48000);
    expect(probe.audioStream?.channels).toBe(2);
  }, 120_000);
});
