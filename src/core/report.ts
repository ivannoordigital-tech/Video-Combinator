import fs from "node:fs";
import path from "node:path";
import { Manifest } from "../schemas/manifest.js";
import { ProductConfig } from "../schemas/product.js";

export class ReportGenerator {
  public static generateCsv(
    manifest: Manifest,
    product: ProductConfig,
    delimiter: "," | ";" = ",",
    includeInactive = false
  ): string {
    const columns = [
      "filename",
      "product",
      "hook",
      "body",
      "cta",
      "music",
      "duration_seconds",
      "created_at",
      "status",
      "size_mb",
      "width",
      "height",
      "fps",
    ];

    const escapeCell = (val: string | number): string => {
      const str = String(val);
      if (str.includes(delimiter) || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines: string[] = [];
    lines.push(columns.map(escapeCell).join(delimiter));

    for (const [filename, item] of Object.entries(manifest.outputs)) {
      if (!includeInactive && item.status !== "DONE") {
        continue;
      }

      const sizeMb = (item.sizeBytes / 1024 / 1024).toFixed(2);
      const row = [
        filename,
        product.slug,
        item.hook,
        item.body,
        item.cta,
        item.music ?? "",
        item.durationSeconds.toFixed(2),
        item.createdAt,
        item.status,
        sizeMb,
        product.video.width,
        product.video.height,
        product.video.fps,
      ];
      lines.push(row.map(escapeCell).join(delimiter));
    }

    // UTF-8 BOM + CRLF
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  public static saveReport(
    outputDir: string,
    manifest: Manifest,
    product: ProductConfig,
    delimiter: "," | ";" = ","
  ): string {
    const csvContent = this.generateCsv(manifest, product, delimiter);
    const reportPath = path.join(outputDir, "report_iklan.csv");
    const tmpPath = path.join(outputDir, "report_iklan.csv.tmp");

    fs.writeFileSync(tmpPath, csvContent, "utf-8");
    fs.renameSync(tmpPath, reportPath);

    return reportPath;
  }
}
