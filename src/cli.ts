import path from "node:path";
import fs from "node:fs";
import { FFmpegResolver } from "./core/ffmpeg.js";
import { ScanEngine } from "./core/scan.js";
import { PlanEngine } from "./core/plan.js";
import { RenderEngine } from "./core/render.js";
import { ManifestManager } from "./core/manifest.js";
import { ReportGenerator } from "./core/report.js";
import { ProductConfigSchema } from "./schemas/product.js";
import { AssetsRegistrySchema } from "./schemas/assets.js";
import { Job, JobScope } from "./schemas/job.js";

function findProjectRoot(): string {
  let curr = import.meta.dirname;
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "package.json"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return process.cwd();
}
const ROOT_DIR = findProjectRoot();

function writeJsonAtomic(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, targetPath);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "doctor";

  if (command === "doctor") {
    console.log("Checking system & binary health...");
    const health = await FFmpegResolver.checkHealth(true);
    console.log("✅ FFmpeg & FFprobe verified:");
    console.log(`   FFmpeg  : ${health.ffmpegVersion}`);
    console.log(`   Path    : ${health.ffmpegPath}`);
    console.log(`   FFprobe : ${health.ffprobeVersion}`);
    console.log(`   Path    : ${health.ffprobePath}`);
    return;
  }

  const productArgIndex = args.indexOf("--product");
  const productSlug = productArgIndex !== -1 ? args[productArgIndex + 1] : "default-product";

  const scopeArgIndex = args.indexOf("--scope");
  const scope: JobScope = (scopeArgIndex !== -1 ? args[scopeArgIndex + 1] : "new") as JobScope;

  const productDir = path.join(ROOT_DIR, "state", productSlug);
  const productConfigPath = path.join(productDir, "product.json");

  // Load or create default product
  let product = ProductConfigSchema.parse({
    slug: productSlug,
    displayName: productSlug.replace(/-/g, " ").toUpperCase(),
    createdAt: new Date().toISOString(),
  });

  if (fs.existsSync(productConfigPath)) {
    product = ProductConfigSchema.parse(JSON.parse(fs.readFileSync(productConfigPath, "utf-8")));
  } else {
    fs.mkdirSync(productDir, { recursive: true });
    writeJsonAtomic(productConfigPath, product);
  }

  // Load or init assets registry
  const assetsPath = path.join(productDir, "assets.json");
  let registry = AssetsRegistrySchema.parse({
    schemaVersion: 1,
    specHash: "init",
    assets: { hook: {}, body: {}, cta: {} },
  });
  if (fs.existsSync(assetsPath)) {
    registry = AssetsRegistrySchema.parse(JSON.parse(fs.readFileSync(assetsPath, "utf-8")));
  }

  const outputDir = path.join(ROOT_DIR, "output", productSlug);
  const manifest = ManifestManager.loadManifest(outputDir, product);

  if (command === "scan") {
    console.log(`Scanning assets for product: ${productSlug}...`);
    registry = await ScanEngine.scanProductAssets(ROOT_DIR, product, registry);
    writeJsonAtomic(assetsPath, registry);
    console.log(`✅ Scan completed.`);
    console.log(`   Hooks  : ${Object.keys(registry.assets.hook).length}`);
    console.log(`   Bodies : ${Object.keys(registry.assets.body).length}`);
    console.log(`   CTAs   : ${Object.keys(registry.assets.cta).length}`);
    return;
  }

  if (command === "plan") {
    registry = await ScanEngine.scanProductAssets(ROOT_DIR, product, registry);
    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scope);
    console.log(`=== Plan Summary: ${productSlug} (Scope: ${scope}) ===`);
    console.log(`Total Combinations : ${plan.counts.total}`);
    console.log(`Already Done       : ${plan.counts.done}`);
    console.log(`Stale              : ${plan.counts.stale}`);
    console.log(`Queued to Render   : ${plan.counts.queued}`);
    console.log(`Estimated ETA      : ${plan.estimate.etaSeconds}s`);
    return;
  }

  if (command === "render") {
    console.log(`Scanning assets...`);
    registry = await ScanEngine.scanProductAssets(ROOT_DIR, product, registry);
    writeJsonAtomic(assetsPath, registry);

    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scope);
    console.log(`Plan ready: ${plan.counts.queued} video to render.`);

    if (plan.counts.queued === 0) {
      console.log("No new videos in queue. Nothing to render!");
      return;
    }

    const job: Job = {
      jobId: `job_${Date.now()}`,
      product: productSlug,
      status: "RUNNING",
      scope,
      total: plan.counts.queued,
      done: 0,
      failed: 0,
      skipped: plan.counts.done,
      current: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      etaSeconds: plan.estimate.etaSeconds,
      cancelled: false,
    };

    const engine = new RenderEngine();
    console.log("Starting render engine...");
    const t0 = performance.now();

    await engine.renderQueue(ROOT_DIR, product, plan.queue, manifest, job, {
      onItemDone: (filename, item, done, total) => {
        console.log(`  [DONE ${done}/${total}] ${filename} (${item.durationSeconds.toFixed(1)}s)`);
      },
      onItemFailed: (filename, err, done, total) => {
        console.error(`  [FAILED ${done}/${total}] ${filename}: ${err}`);
      },
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`\nRender completed in ${elapsed}s! Done: ${job.done}, Failed: ${job.failed}`);
    return;
  }

  if (command === "report") {
    const reportPath = ReportGenerator.saveReport(outputDir, manifest, product);
    console.log(`CSV Report generated at: ${reportPath}`);
    return;
  }

  console.log(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error("CLI error:", err);
  process.exit(1);
});
