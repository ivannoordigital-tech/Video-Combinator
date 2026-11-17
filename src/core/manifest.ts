import fs from "node:fs";
import path from "node:path";
import { Manifest, ManifestSchema, OutputItem } from "../schemas/manifest.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";

export class ManifestManager {
  /**
   * Membaca manifest.json atau menginisialisasi manifest kosong jika belum ada.
   * Melakukan recovery otomatis dari manifest.jsonl jika terjadi crash.
   */
  public static loadManifest(outputDir: string, product: ProductConfig): Manifest {
    fs.mkdirSync(outputDir, { recursive: true });
    const manifestPath = path.join(outputDir, "manifest.json");
    const jsonlPath = path.join(outputDir, "manifest.jsonl");

    const specHash = computeSpecHash(product.video, product.audio);
    let manifest: Manifest = {
      schemaVersion: 1,
      product: product.slug,
      specHash,
      updatedAt: new Date().toISOString(),
      tool: { app: "1.0.0", ffmpeg: "9.0" },
      outputs: {},
    };

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        manifest = ManifestSchema.parse(JSON.parse(raw));
      } catch {
        // Fallback ke recovery jika manifest.json rusak
      }
    }

    // Replay recovery dari jsonl jika ada entri yang belum tercatat
    if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { filename: string; item: OutputItem };
          if (entry.filename && entry.item) {
            manifest.outputs[entry.filename] = entry.item;
          }
        } catch {
          // ignore corrupted lines
        }
      }
    }

    return manifest;
  }

  /**
   * Menyimpan output item ke manifest.jsonl (append) dan manifest.json (atomik).
   */
  public static appendItem(
    outputDir: string,
    manifest: Manifest,
    filename: string,
    item: OutputItem,
    forceFlush = false
  ): void {
    manifest.outputs[filename] = item;
    manifest.updatedAt = new Date().toISOString();

    const jsonlPath = path.join(outputDir, "manifest.jsonl");
    const logLine = JSON.stringify({ filename, item }) + "\n";
    fs.appendFileSync(jsonlPath, logLine, "utf-8");

    if (forceFlush || Object.keys(manifest.outputs).length % 10 === 0) {
      this.saveManifest(outputDir, manifest);
    }
  }

  /**
   * Menulis manifest.json secara atomik (.tmp -> rename).
   */
  public static saveManifest(outputDir: string, manifest: Manifest): void {
    const manifestPath = path.join(outputDir, "manifest.json");
    const tmpPath = path.join(outputDir, "manifest.json.tmp");

    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
    fs.renameSync(tmpPath, manifestPath);
  }
}
