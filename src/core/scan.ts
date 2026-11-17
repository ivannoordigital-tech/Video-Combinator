import fs from "node:fs";
import path from "node:path";
import { AssetKind, AssetsRegistry, AssetItem } from "../schemas/assets.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { NamingUtils } from "./naming.js";
import { IngestEngine } from "./ingest.js";
import { FingerprintService } from "./fingerprint.js";

export class ScanEngine {
  /**
   * Cek magic bytes untuk memastikan file benar-benar MP4/QuickTime (offset 4 adalah 'ftyp').
   */
  public static isValidMp4Magic(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < 12) return false;

      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(8);
      fs.readSync(fd, buffer, 0, 8, 4);
      fs.closeSync(fd);

      return buffer.toString("ascii", 0, 4) === "ftyp";
    } catch {
      return false;
    }
  }

  /**
   * Memindai folder database/<product>/{hooks,bodies,ctas} dan memperbarui assets.json.
   */
  public static async scanProductAssets(
    productRoot: string,
    product: ProductConfig,
    currentRegistry: AssetsRegistry
  ): Promise<AssetsRegistry> {
    const kinds: AssetKind[] = ["hook", "body", "cta"];
    const folderNames: Record<AssetKind, string> = {
      hook: "hooks",
      body: "bodies",
      cta: "ctas",
    };

    const specHash = computeSpecHash(product.video, product.audio);
    const updatedRegistry: AssetsRegistry = {
      schemaVersion: 1,
      specHash,
      assets: {
        hook: { ...currentRegistry.assets.hook },
        body: { ...currentRegistry.assets.body },
        cta: { ...currentRegistry.assets.cta },
      },
    };

    const cacheDir = path.join(productRoot, "cache", product.slug);

    for (const kind of kinds) {
      const dirPath = path.join(productRoot, "database", product.slug, folderNames[kind]);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const files = fs.readdirSync(dirPath);
      const activeFilenames = new Set<string>();

      // Buat peta slug yang sudah terpakai untuk menghindari bentrok
      const usedSlugs = new Set<string>();
      for (const [filename, item] of Object.entries(updatedRegistry.assets[kind])) {
        usedSlugs.add(item.slug);
      }

      for (const file of files) {
        if (file.startsWith(".") || file.endsWith(".part") || file.endsWith(".tmp")) {
          continue;
        }

        const ext = path.extname(file).toLowerCase();
        if (ext !== ".mp4") continue;

        activeFilenames.add(file);
        const filePath = path.join(dirPath, file);

        // Validasi magic bytes
        if (!this.isValidMp4Magic(filePath)) {
          const stats = fs.statSync(filePath);
          updatedRegistry.assets[kind][file] = {
            slug: NamingUtils.toSlug(file),
            enabled: false,
            sha256: "corrupt",
            sizeBytes: stats.size,
            mtimeMs: stats.mtimeMs,
            durationSeconds: 0,
            origin: "scan",
            status: "ERROR",
            ingestedAt: new Date().toISOString(),
            error: "File korup atau bukan MP4 yang valid (magic bytes mismatch)",
          };
          continue;
        }

        // Tentukan slug stabil
        let existingItem = updatedRegistry.assets[kind][file];
        let slug = existingItem?.slug;

        if (!slug) {
          const baseSlug = NamingUtils.toSlug(file, product.naming.maxSlugLength);
          slug = baseSlug;
          let counter = 2;
          while (usedSlugs.has(slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
          }
          usedSlugs.add(slug);
        }

        // Cek apakah file berubah (mtime / size)
        const fingerprint = await FingerprintService.getFingerprint(filePath);
        const isModified =
          !existingItem ||
          existingItem.sizeBytes !== fingerprint.sizeBytes ||
          Math.abs(existingItem.mtimeMs - fingerprint.mtimeMs) > 10 ||
          currentRegistry.specHash !== specHash;

        if (isModified || existingItem?.status !== "READY") {
          try {
            const ingested = await IngestEngine.ingestClip(filePath, slug, product, cacheDir);
            updatedRegistry.assets[kind][file] = ingested;
          } catch (err) {
            updatedRegistry.assets[kind][file] = {
              slug,
              enabled: false,
              sha256: fingerprint.sha256,
              sizeBytes: fingerprint.sizeBytes,
              mtimeMs: fingerprint.mtimeMs,
              durationSeconds: 0,
              origin: "scan",
              status: "ERROR",
              ingestedAt: new Date().toISOString(),
              error: (err as Error).message,
            };
          }
        }
      }

      // Tandai file yang hilang di folder sebagai ERROR / tidak aktif
      for (const existingFile of Object.keys(updatedRegistry.assets[kind])) {
        if (!activeFilenames.has(existingFile)) {
          const item = updatedRegistry.assets[kind][existingFile];
          if (item) {
            item.enabled = false;
            item.status = "ERROR";
            item.error = "File tidak ditemukan di folder database";
          }
        }
      }
    }

    return updatedRegistry;
  }
}
