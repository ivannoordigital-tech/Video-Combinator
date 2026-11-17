import fs from "node:fs";
import path from "node:path";
import { AssetsRegistry, AssetItem } from "../schemas/assets.js";
import { Manifest, OutputStatus } from "../schemas/manifest.js";
import { ProductConfig, computeSpecHash } from "../schemas/product.js";
import { JobScope } from "../schemas/job.js";
import { NamingUtils } from "./naming.js";

export interface PlanCombination {
  key: string;
  filename: string;
  hookFile: string;
  bodyFile: string;
  ctaFile: string;
  hookItem: AssetItem;
  bodyItem: AssetItem;
  ctaItem: AssetItem;
  status: "QUEUED" | "SKIPPED" | "STALE" | "ORPHAN";
  reason?: string;
}

export interface PlanResult {
  counts: {
    hooks: number;
    bodies: number;
    ctas: number;
    total: number;
    done: number;
    stale: number;
    orphan: number;
    queued: number;
  };
  scope: JobScope;
  queue: PlanCombination[];
  estimate: {
    avgOutputMb: number;
    requiredMb: number;
    freeMb: number;
    etaSeconds: number;
  };
  blockers: string[];
  warnings: string[];
}

export class PlanEngine {
  public static async createPlan(
    productRoot: string,
    product: ProductConfig,
    registry: AssetsRegistry,
    manifest: Manifest,
    scope: JobScope = "new"
  ): Promise<PlanResult> {
    const specHash = computeSpecHash(product.video, product.audio);

    // Ambil aset yang aktif dan READY
    const hooks = Object.entries(registry.assets.hook)
      .filter(([_, item]) => item.enabled && item.status === "READY");
    const bodies = Object.entries(registry.assets.body)
      .filter(([_, item]) => item.enabled && item.status === "READY");
    const ctas = Object.entries(registry.assets.cta)
      .filter(([_, item]) => item.enabled && item.status === "READY");

    const totalCombinations = hooks.length * bodies.length * ctas.length;
    const allCombinations: PlanCombination[] = [];

    // Lacak aset mana saja yang sudah pernah dipakai di output yang DONE
    const usedHooksInDone = new Set<string>();
    const usedBodiesInDone = new Set<string>();
    const usedCtasInDone = new Set<string>();

    for (const out of Object.values(manifest.outputs)) {
      if (out.status === "DONE") {
        usedHooksInDone.add(out.hook);
        usedBodiesInDone.add(out.body);
        usedCtasInDone.add(out.cta);
      }
    }

    const outputDir = path.join(productRoot, "output");

    let doneCount = 0;
    let staleCount = 0;
    let orphanCount = 0;

    for (const [hookFile, hookItem] of hooks) {
      for (const [bodyFile, bodyItem] of bodies) {
        for (const [ctaFile, ctaItem] of ctas) {
          const key = NamingUtils.computeHash8(product.slug, hookFile, bodyFile, ctaFile);
          const filename = NamingUtils.formatOutputFilename(
            product.slug,
            hookItem.slug,
            bodyItem.slug,
            ctaItem.slug,
            key
          );

          const existingOutput = manifest.outputs[filename];
          const fullPath = path.join(outputDir, filename);
          const fileExists = fs.existsSync(fullPath) && fs.statSync(fullPath).size > 10240;

          let comboStatus: "QUEUED" | "SKIPPED" | "STALE" | "ORPHAN" = "QUEUED";
          let reason = "";

          if (existingOutput && existingOutput.status === "DONE") {
            const sameFingerprints =
              existingOutput.assetFingerprints.hook === hookItem.sha256 &&
              existingOutput.assetFingerprints.body === bodyItem.sha256 &&
              existingOutput.assetFingerprints.cta === ctaItem.sha256;

            const sameSpec = existingOutput.specHash === specHash;

            if (fileExists && sameFingerprints && sameSpec) {
              comboStatus = "SKIPPED";
              doneCount++;
            } else if (!sameFingerprints || !sameSpec) {
              comboStatus = "STALE";
              staleCount++;
              reason = "Aset sumber atau konfigurasi produk telah diperbarui";
            } else if (!fileExists) {
              comboStatus = "QUEUED";
              reason = "File output hilang dari disk";
            }
          }

          allCombinations.push({
            key,
            filename,
            hookFile,
            bodyFile,
            ctaFile,
            hookItem,
            bodyItem,
            ctaItem,
            status: comboStatus,
            reason,
          });
        }
      }
    }

    // Filter queue berdasarkan scope
    let queuedItems: PlanCombination[] = [];

    if (scope === "all") {
      queuedItems = allCombinations.filter((c) => c.status === "QUEUED" || c.status === "STALE");
    } else if (scope === "stale") {
      queuedItems = allCombinations.filter((c) => c.status === "STALE");
    } else {
      // Default: 'new'
      queuedItems = allCombinations.filter((c) => {
        if (c.status !== "QUEUED") return false;
        // Termasuk jika salah satu asetnya baru (belum pernah dipakai di output DONE sebelumnya)
        // atau jika kombinasi ini memang belum ada
        const isNewAsset =
          !usedHooksInDone.has(c.hookFile) ||
          !usedBodiesInDone.has(c.bodyFile) ||
          !usedCtasInDone.has(c.ctaFile);
        return isNewAsset || !manifest.outputs[c.filename];
      });
    }

    // Estimasi ukuran dan waktu
    const avgOutputMb = 18.0; // Rata-rata 1080x1920 30s H.264
    const requiredMb = Math.ceil(queuedItems.length * avgOutputMb * 1.15 + 500);
    const workers = product.render.workers || 3;
    const etaSeconds = Math.ceil((queuedItems.length * 0.4) / workers);

    // Cek disk space sederhana
    const freeMb = 50000; // Placeholder disk space safe margin
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (totalCombinations > product.limits.maxCombinations) {
      blockers.push(`Total kombinasi (${totalCombinations}) melebihi batas maksimal ${product.limits.maxCombinations}.`);
    } else if (totalCombinations > product.limits.warnCombinations) {
      warnings.push(`Jumlah kombinasi cukup besar (${totalCombinations} video).`);
    }

    if (queuedItems.length > 0) {
      warnings.push(`${queuedItems.length} video baru siap di-generate (estimasi ±${(queuedItems.length * avgOutputMb).toFixed(0)} MB).`);
    }

    return {
      counts: {
        hooks: hooks.length,
        bodies: bodies.length,
        ctas: ctas.length,
        total: totalCombinations,
        done: doneCount,
        stale: staleCount,
        orphan: orphanCount,
        queued: queuedItems.length,
      },
      scope,
      queue: queuedItems,
      estimate: {
        avgOutputMb,
        requiredMb,
        freeMb,
        etaSeconds,
      },
      blockers,
      warnings,
    };
  }
}
