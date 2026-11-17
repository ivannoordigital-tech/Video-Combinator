import { describe, it, expect } from "vitest";
import {
  ProductConfigSchema,
  computeSpecHash,
  AssetsRegistrySchema,
  ManifestSchema,
  JobSchema,
} from "../src/schemas/index.js";

describe("T0.2: Zod Schemas Validation", () => {
  it("harus meloloskan product.json yang valid", () => {
    const validProduct = {
      schemaVersion: 1,
      slug: "produk-sepatu",
      displayName: "Produk Sepatu",
      createdAt: "2026-11-17T09:00:00+07:00",
      video: {
        width: 1080,
        height: 1920,
        fps: 30,
        fit: "pad",
        codec: "h264",
        profile: "high",
        level: "4.1",
        pixFmt: "yuv420p",
        crf: 18,
        preset: "veryfast",
        gop: 60,
      },
      audio: {
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
        bitrate: "192k",
        loudnorm: true,
        targetLufs: -16,
      },
    };

    const parsed = ProductConfigSchema.parse(validProduct);
    expect(parsed.slug).toBe("produk-sepatu");
    expect(parsed.render.mode).toBe("fast"); // default value
    expect(parsed.render.workers).toBe(3);

    const hash = computeSpecHash(parsed.video, parsed.audio);
    expect(hash).toHaveLength(12);
  });

  it("harus menolak slug produk yang berbahaya atau tidak valid", () => {
    const invalidSlugs = ["../etc", "..%2f", "CON", "a b", "PRODUK", "a_b", ""];

    for (const slug of invalidSlugs) {
      expect(() =>
        ProductConfigSchema.parse({
          slug,
          displayName: "Test",
          createdAt: new Date().toISOString(),
        })
      ).toThrow();
    }
  });

  it("harus memvalidasi assets.json registry", () => {
    const registry = {
      schemaVersion: 1,
      specHash: "ab12cd34ef56",
      assets: {
        hook: {
          "h1.mp4": {
            slug: "hook-01",
            enabled: true,
            sha256: "deadbeef",
            sizeBytes: 1024,
            mtimeMs: 123456789,
            durationSeconds: 4.5,
            origin: "scan",
            status: "READY",
            ingestedAt: new Date().toISOString(),
            error: null,
          },
        },
        body: {},
        cta: {},
      },
    };

    const parsed = AssetsRegistrySchema.parse(registry);
    expect(parsed.assets.hook["h1.mp4"]?.status).toBe("READY");
  });

  it("harus memvalidasi manifest.json", () => {
    const manifest = {
      schemaVersion: 1,
      product: "produk-sepatu",
      specHash: "ab12cd34ef56",
      updatedAt: new Date().toISOString(),
      tool: { app: "1.0.0", ffmpeg: "9.0" },
      outputs: {
        "produk-sepatu__hook-01__body-01__cta-01__12345678.mp4": {
          key: "12345678",
          hook: "h1.mp4",
          body: "b1.mp4",
          cta: "c1.mp4",
          status: "DONE",
          durationSeconds: 15.2,
          sizeBytes: 5000000,
          createdAt: new Date().toISOString(),
          assetFingerprints: { hook: "h", body: "b", cta: "c" },
          specHash: "ab12cd34ef56",
          verified: true,
          error: null,
        },
      },
    };

    const parsed = ManifestSchema.parse(manifest);
    expect(parsed.product).toBe("produk-sepatu");
  });

  it("harus memvalidasi job.json state", () => {
    const job = {
      jobId: "job_01JXYZ",
      product: "produk-sepatu",
      status: "RUNNING",
      scope: "new",
      total: 25,
      done: 5,
      failed: 0,
      skipped: 0,
      current: "test.mp4",
      startedAt: new Date().toISOString(),
      completedAt: null,
      etaSeconds: 10,
      cancelled: false,
    };

    const parsed = JobSchema.parse(job);
    expect(parsed.status).toBe("RUNNING");
  });
});
