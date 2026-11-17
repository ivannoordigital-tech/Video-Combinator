import express, { Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { FFmpegResolver } from "./core/ffmpeg.js";
import { ScanEngine } from "./core/scan.js";
import { PlanEngine } from "./core/plan.js";
import { RenderEngine } from "./core/render.js";
import { ManifestManager } from "./core/manifest.js";
import { ReportGenerator } from "./core/report.js";
import { ProductConfigSchema, ProductConfig } from "./schemas/product.js";
import { AssetsRegistrySchema, AssetsRegistry } from "./schemas/assets.js";
import { Job, JobScope } from "./schemas/job.js";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, "public")));

// --- Security Middleware (FR-11) ---
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host || "";
  if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    res.status(403).json({ error: { code: "E_FORBIDDEN", message: "Akses hanya diizinkan melalui loopback 127.0.0.1" } });
    return;
  }

  // Mutating request check
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.path.startsWith("/api/")) {
    const appHeader = req.headers["x-app-request"];
    if (appHeader !== "1") {
      res.status(403).json({ error: { code: "E_FORBIDDEN", message: "Header X-App-Request: 1 wajib disertakan" } });
      return;
    }
  }

  next();
});

// State in-memory
const activeJobs = new Map<string, { job: Job; engine: RenderEngine }>();
const sseClients = new Map<string, Set<Response>>();

function broadcastSSE(slug: string, event: string, data: unknown) {
  const clients = sseClients.get(slug);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function getProductPaths(slug: string) {
  const safeSlug = slug.replace(/[^a-z0-9-]/g, "");
  return {
    slug: safeSlug,
    stateDir: path.join(ROOT_DIR, "state", safeSlug),
    configPath: path.join(ROOT_DIR, "state", safeSlug, "product.json"),
    assetsPath: path.join(ROOT_DIR, "state", safeSlug, "assets.json"),
    outputDir: path.join(ROOT_DIR, "output", safeSlug),
    databaseDir: path.join(ROOT_DIR, "database", safeSlug),
  };
}

function loadProduct(slug: string): ProductConfig {
  const { configPath } = getProductPaths(slug);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Produk tidak ditemukan: ${slug}`);
  }
  return ProductConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf-8")));
}

function loadRegistry(slug: string): AssetsRegistry {
  const { assetsPath } = getProductPaths(slug);
  if (fs.existsSync(assetsPath)) {
    return AssetsRegistrySchema.parse(JSON.parse(fs.readFileSync(assetsPath, "utf-8")));
  }
  return { schemaVersion: 1, specHash: "init", assets: { hook: {}, body: {}, cta: {} } };
}

// --- Endpoints ---

// GET /api/health
app.get("/api/health", async (req, res) => {
  try {
    const health = await FFmpegResolver.checkHealth();
    res.json({ ok: true, health, rootDir: ROOT_DIR });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/products
app.get("/api/products", (req, res) => {
  const stateRoot = path.join(ROOT_DIR, "state");
  if (!fs.existsSync(stateRoot)) {
    fs.mkdirSync(stateRoot, { recursive: true });
  }
  const dirs = fs.readdirSync(stateRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const products = dirs.map((slug) => {
    try {
      const p = loadProduct(slug);
      const reg = loadRegistry(slug);
      return {
        slug: p.slug,
        displayName: p.displayName,
        counts: {
          hooks: Object.keys(reg.assets.hook).length,
          bodies: Object.keys(reg.assets.body).length,
          ctas: Object.keys(reg.assets.cta).length,
        },
      };
    } catch {
      return { slug, displayName: slug, counts: { hooks: 0, bodies: 0, ctas: 0 } };
    }
  });

  res.json({ products });
});

// POST /api/products
app.post("/api/products", (req, res) => {
  try {
    const parsed = ProductConfigSchema.parse({
      ...req.body,
      createdAt: new Date().toISOString(),
    });
    const paths = getProductPaths(parsed.slug);
    if (fs.existsSync(paths.configPath)) {
      res.status(409).json({ error: { code: "E_PRODUCT_EXISTS", message: "Produk dengan slug ini sudah ada" } });
      return;
    }

    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.mkdirSync(path.join(paths.databaseDir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(paths.databaseDir, "bodies"), { recursive: true });
    fs.mkdirSync(path.join(paths.databaseDir, "ctas"), { recursive: true });
    fs.mkdirSync(paths.outputDir, { recursive: true });

    fs.writeFileSync(paths.configPath, JSON.stringify(parsed, null, 2), "utf-8");
    res.status(201).json({ product: parsed });
  } catch (err) {
    res.status(400).json({ error: { code: "E_VALIDATION_ERROR", message: (err as Error).message } });
  }
});

// GET /api/products/:slug
app.get("/api/products/:slug", (req, res) => {
  try {
    const product = loadProduct(req.params.slug);
    const registry = loadRegistry(req.params.slug);
    res.json({ product, registry });
  } catch (err) {
    res.status(404).json({ error: { code: "E_NOT_FOUND", message: (err as Error).message } });
  }
});

// POST /api/products/:slug/scan
app.post("/api/products/:slug/scan", async (req, res) => {
  try {
    const product = loadProduct(req.params.slug);
    let registry = loadRegistry(req.params.slug);
    const { assetsPath } = getProductPaths(req.params.slug);

    registry = await ScanEngine.scanProductAssets(ROOT_DIR, product, registry);
    fs.writeFileSync(assetsPath, JSON.stringify(registry, null, 2), "utf-8");

    res.json({ ok: true, registry });
  } catch (err) {
    res.status(500).json({ error: { code: "E_SCAN_FAILED", message: (err as Error).message } });
  }
});

// GET /api/products/:slug/plan
app.get("/api/products/:slug/plan", async (req, res) => {
  try {
    const product = loadProduct(req.params.slug);
    const registry = loadRegistry(req.params.slug);
    const { outputDir } = getProductPaths(req.params.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const scope = (req.query.scope as JobScope) || "new";

    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scope);
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: { code: "E_PLAN_FAILED", message: (err as Error).message } });
  }
});

// POST /api/products/:slug/render
app.post("/api/products/:slug/render", async (req, res) => {
  const slug = req.params.slug;
  if (activeJobs.has(slug)) {
    res.status(409).json({ error: { code: "E_JOB_RUNNING", message: "Proses render sedang berlangsung untuk produk ini" } });
    return;
  }

  try {
    const product = loadProduct(slug);
    const registry = loadRegistry(slug);
    const { outputDir } = getProductPaths(slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const scope = (req.body.scope as JobScope) || "new";

    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scope);
    if (plan.counts.queued === 0) {
      res.status(422).json({ error: { code: "E_NO_ITEMS", message: "Tidak ada video baru dalam antrean render" } });
      return;
    }

    const job: Job = {
      jobId: `job_${Date.now()}`,
      product: slug,
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
    activeJobs.set(slug, { job, engine });

    // Background execution
    (async () => {
      try {
        await engine.renderQueue(ROOT_DIR, product, plan.queue, manifest, job, {
          onItemDone: (filename, item, done, total) => {
            broadcastSSE(slug, "item", { filename, item, done, total });
          },
          onItemFailed: (filename, error, done, total) => {
            broadcastSSE(slug, "error", { filename, error, done, total });
          },
          onProgress: (done, total, current) => {
            broadcastSSE(slug, "progress", { done, total, current });
          },
        });
      } finally {
        activeJobs.delete(slug);
        broadcastSSE(slug, "done", { job });
      }
    })();

    res.status(202).json({ job });
  } catch (err) {
    res.status(500).json({ error: { code: "E_RENDER_ERROR", message: (err as Error).message } });
  }
});

// POST /api/products/:slug/render/cancel
app.post("/api/products/:slug/render/cancel", (req, res) => {
  const active = activeJobs.get(req.params.slug);
  if (!active) {
    res.status(404).json({ error: { code: "E_NOT_FOUND", message: "Tidak ada proses render yang sedang aktif" } });
    return;
  }

  active.engine.cancel();
  active.job.status = "CANCELLED";
  active.job.cancelled = true;
  activeJobs.delete(req.params.slug);
  broadcastSSE(req.params.slug, "cancelled", { job: active.job });

  res.status(202).json({ ok: true, job: active.job });
});

// GET /api/products/:slug/job
app.get("/api/products/:slug/job", (req, res) => {
  const active = activeJobs.get(req.params.slug);
  if (active) {
    res.json({ job: active.job });
  } else {
    res.json({ job: null });
  }
});

// GET /api/products/:slug/events (SSE)
app.get("/api/products/:slug/events", (req, res) => {
  const slug = req.params.slug;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (!sseClients.has(slug)) {
    sseClients.set(slug, new Set());
  }
  sseClients.get(slug)!.add(res);

  // Send initial snapshot
  const active = activeJobs.get(slug);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ job: active?.job || null })}\n\n`);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(slug)?.delete(res);
  });
});

// GET /api/products/:slug/report.csv
app.get("/api/products/:slug/report.csv", (req, res) => {
  try {
    const product = loadProduct(req.params.slug);
    const { outputDir } = getProductPaths(req.params.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const csvContent = ReportGenerator.generateCsv(manifest, product);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="report_${req.params.slug}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: { code: "E_REPORT_FAILED", message: (err as Error).message } });
  }
});

// POST /api/products/:slug/open-output
app.post("/api/products/:slug/open-output", (req, res) => {
  const { outputDir } = getProductPaths(req.params.slug);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  execFile("explorer.exe", [outputDir], { windowsHide: true });
  res.status(204).end();
});

// Media Range Streaming (FR-8)
app.get("/api/products/:slug/media/:kind/:file", (req, res) => {
  const { slug, kind, file } = req.params;
  const folderNames: Record<string, string> = { hook: "hooks", body: "bodies", cta: "ctas" };
  const folder = folderNames[kind || ""];
  if (!folder) {
    res.status(400).end();
    return;
  }

  const filePath = path.join(ROOT_DIR, "database", slug, folder, file);
  if (!fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0] || "0", 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Server Listen with Port Fallback (3210 -> 3219)
export async function startServer(startPort = 3210): Promise<number> {
  let port = startPort;
  while (port <= 3219) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            reject(err);
          } else {
            reject(err);
          }
        });
        server.listen(port, "127.0.0.1", () => {
          resolve();
        });
      });
      console.log(`🚀 Video Combinator Dashboard berjalan di: http://127.0.0.1:${port}`);
      return port;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.log(`Port ${port} sedang dipakai, mencoba port ${port + 1}...`);
        port++;
      } else {
        throw err;
      }
    }
  }
  throw new Error("Semua port 3210-3219 sedang digunakan.");
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer().catch((err) => {
    console.error("Gagal menyalakan server:", err);
    process.exit(1);
  });
}
