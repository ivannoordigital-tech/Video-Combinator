import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScanEngine, ScanFolderUnreadableError } from "../src/core/scan.js";
import { AssetsRegistrySchema } from "../src/schemas/assets.js";
import { ProductConfigSchema, computeSpecHash } from "../src/schemas/product.js";

function makeProduct(slug = "test-produk") {
  return ProductConfigSchema.parse({
    slug,
    displayName: "Test Produk",
    createdAt: new Date().toISOString(),
  });
}

function emptyRegistry() {
  return AssetsRegistrySchema.parse({
    schemaVersion: 1,
    specHash: "init",
    assets: { hook: {}, body: {}, cta: {}, music: {} },
  });
}

function makeReadyItem(file: string) {
  return {
    slug: file.replace(/\.[^.]+$/, "").toLowerCase(),
    enabled: true,
    sha256: "a".repeat(64),
    sizeBytes: 1234,
    mtimeMs: Date.now(),
    durationSeconds: 3,
    origin: "scan" as const,
    status: "READY" as const,
    ingestedAt: new Date().toISOString(),
    error: null,
  };
}

describe("Scan diagnostics & prune", () => {
  let root: string;
  let product: ReturnType<typeof makeProduct>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-scan-"));
    product = makeProduct();
    for (const dir of ["hooks", "bodies", "ctas", "backsounds"]) {
      fs.mkdirSync(path.join(root, "database", product.slug, dir), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("menandai entri hilang dengan report dan tidak menghapusnya", async () => {
    const registry = emptyRegistry();
    registry.assets.hook["missing.mp4"] = makeReadyItem("missing.mp4");
    registry.assets.body["ok.mp4"] = makeReadyItem("ok.mp4");

    const { registry: updated, report } = await ScanEngine.scanProductAssetsDetailed(root, product, registry);

    expect(updated.assets.hook["missing.mp4"]?.status).toBe("ERROR");
    expect(updated.assets.hook["missing.mp4"]?.enabled).toBe(false);
    expect(updated.assets.hook["missing.mp4"]?.error).toContain("File tidak ditemukan");
    expect(report.missing).toEqual([
      { kind: "hook", file: "missing.mp4", sizeBytes: 1234 },
      { kind: "body", file: "ok.mp4", sizeBytes: 1234 },
    ]);
    expect(report.counts.hook.missing).toBe(1);
    expect(report.folders).toHaveLength(4);
    expect(report.folders.find((f) => f.kind === "hook")?.dirPath).toBe(
      path.join(root, "database", product.slug, "hooks")
    );
  });

  it("pruneMissingAssets menghapus hanya entri yang filenya tidak ada", () => {
    const registry = emptyRegistry();
    registry.assets.hook["missing.mp4"] = makeReadyItem("missing.mp4");
    registry.assets.hook["present.mp4"] = {
      ...makeReadyItem("present.mp4"),
      status: "ERROR",
      enabled: false,
      error: "File korup atau bukan MP4 yang valid (magic bytes mismatch)",
    };
    fs.writeFileSync(path.join(root, "database", product.slug, "hooks", "present.mp4"), "not really mp4");

    const { registry: updated, removed } = ScanEngine.pruneMissingAssets(root, product, registry);

    expect(removed).toEqual([{ kind: "hook", file: "missing.mp4", sizeBytes: 1234 }]);
    expect(updated.assets.hook["missing.mp4"]).toBeUndefined();
    expect(updated.assets.hook["present.mp4"]).toBeDefined();
    expect(updated.assets.hook["present.mp4"]?.error).toContain("korup");
  });

  it("pruneMissingAssets melewati folder yang tidak ada dan tetap membersihkan kind lain", () => {
    const registry = emptyRegistry();
    registry.assets.hook["gone.mp4"] = makeReadyItem("gone.mp4");
    registry.assets.cta["x.mp4"] = makeReadyItem("x.mp4");
    fs.rmSync(path.join(root, "database", product.slug, "ctas"), { recursive: true, force: true });

    const { registry: updated, removed, skippedKinds } = ScanEngine.pruneMissingAssets(root, product, registry);

    expect(removed).toEqual([{ kind: "hook", file: "gone.mp4", sizeBytes: 1234 }]);
    expect(skippedKinds).toContain("cta");
    expect(updated.assets.hook["gone.mp4"]).toBeUndefined();
    // Entri pada kind yang tidak terbaca harus dipertahankan.
    expect(updated.assets.cta["x.mp4"]).toBeDefined();
    expect(updated.assets.cta["x.mp4"]?.status).toBe("READY");
  });

  it("pruneMissingAssets melewati folder yang tidak terbaca tanpa menghapus entri", () => {
    const registry = emptyRegistry();
    registry.assets.body["gone.mp4"] = makeReadyItem("gone.mp4");
    const bodiesDir = path.join(root, "database", product.slug, "bodies");
    fs.rmSync(bodiesDir, { recursive: true, force: true });
    fs.writeFileSync(bodiesDir, "not a directory");

    const { registry: updated, removed, skippedKinds } = ScanEngine.pruneMissingAssets(root, product, registry);

    expect(removed).toEqual([]);
    expect(skippedKinds).toContain("body");
    expect(updated.assets.body["gone.mp4"]).toBeDefined();
    expect(updated.assets.body["gone.mp4"]?.status).toBe("READY");
  });

  it("scan gagal aman bila folder database bukan direktori", async () => {
    const registry = emptyRegistry();
    registry.assets.hook["keep.mp4"] = makeReadyItem("keep.mp4");
    const hookDir = path.join(root, "database", product.slug, "hooks");
    fs.rmSync(hookDir, { recursive: true, force: true });
    fs.writeFileSync(hookDir, "not a directory");

    await expect(ScanEngine.scanProductAssetsDetailed(root, product, registry)).rejects.toBeInstanceOf(
      ScanFolderUnreadableError
    );
    // registry input tidak termutasi
    expect(registry.assets.hook["keep.mp4"]?.status).toBe("READY");
  });

  it("wrapper scanProductAssets tetap mengembalikan registry", async () => {
    const registry = emptyRegistry();
    registry.assets.hook["missing.mp4"] = makeReadyItem("missing.mp4");
    const updated = await ScanEngine.scanProductAssets(root, product, registry);
    expect(updated.specHash).toBe(computeSpecHash(product.video, product.audio));
    expect(updated.assets.hook["missing.mp4"]?.status).toBe("ERROR");
  });
});
