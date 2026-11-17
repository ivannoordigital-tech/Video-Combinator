import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { IngestEngine } from "../src/core/ingest.js";
import { VideoProbe } from "../src/core/probe.js";
import { ProductConfigSchema } from "../src/schemas/product.js";

describe("T1.4: Ingest & Normalization Engine", () => {
  const ROOT_DIR = path.resolve(import.meta.dirname, "..");
  const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures");
  const TEST_CACHE_DIR = path.join(ROOT_DIR, "cache", "test_ingest");

  const product = ProductConfigSchema.parse({
    slug: "test-product",
    displayName: "Test Product",
    createdAt: new Date().toISOString(),
  });

  beforeAll(() => {
    fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  it("harus menormalisasi klip 720p@25 fps mono menjadi 1080x1920@30 stereo kanonik", async () => {
    const input = path.join(FIXTURES_DIR, "02_diff_res_fps.mp4");
    const asset = await IngestEngine.ingestClip(input, "diff-res", product, TEST_CACHE_DIR);

    expect(asset.status).toBe("READY");
    expect(asset.durationSeconds).toBeGreaterThan(1.8);

    const normalizedPath = path.join(TEST_CACHE_DIR, "ingest", `${asset.sha256.slice(0, 8)}__diff-res.mp4`);
    expect(fs.existsSync(normalizedPath)).toBe(true);

    const probe = await VideoProbe.probeFile(normalizedPath);
    expect(probe.videoStream?.width).toBe(1080);
    expect(probe.videoStream?.height).toBe(1920);
    expect(probe.fps).toBe(30);
    expect(probe.audioStream?.channels).toBe(2);
    expect(probe.audioStream?.sample_rate).toBe(48000);
  });

  it("harus menormalisasi klip dengan metadata rotasi 90 derajat menjadi tegak tanpa side data", async () => {
    const input = path.join(FIXTURES_DIR, "03_rotation_90.mp4");
    const asset = await IngestEngine.ingestClip(input, "rot-90", product, TEST_CACHE_DIR);

    expect(asset.status).toBe("READY");
    const normalizedPath = path.join(TEST_CACHE_DIR, "ingest", `${asset.sha256.slice(0, 8)}__rot-90.mp4`);
    const probe = await VideoProbe.probeFile(normalizedPath);
    expect(probe.videoStream?.width).toBe(1080);
    expect(probe.videoStream?.height).toBe(1920);
    expect(probe.rotation).toBe(0);
  });

  it("harus menginjeksi silent audio track ke klip tanpa audio", async () => {
    const input = path.join(FIXTURES_DIR, "04_silent_no_audio.mp4");
    const asset = await IngestEngine.ingestClip(input, "silent", product, TEST_CACHE_DIR);

    expect(asset.status).toBe("READY");
    const normalizedPath = path.join(TEST_CACHE_DIR, "ingest", `${asset.sha256.slice(0, 8)}__silent.mp4`);
    const probe = await VideoProbe.probeFile(normalizedPath);
    expect(probe.audioStream).not.toBeNull();
    expect(probe.audioStream?.sample_rate).toBe(48000);
    expect(probe.audioStream?.channels).toBe(2);
  });
});
