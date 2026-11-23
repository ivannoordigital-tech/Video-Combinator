import express, { Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { FFmpegResolver } from "./core/ffmpeg.js";
import { ScanEngine, ScanFolderUnreadableError } from "./core/scan.js";
import { IngestEngine } from "./core/ingest.js";
import { PlanEngine } from "./core/plan.js";
import type { PlanResult, PlanCombination } from "./core/plan.js";
import { RenderEngine } from "./core/render.js";
import { ManifestManager } from "./core/manifest.js";
import type { Manifest } from "./schemas/manifest.js";
import { ReportGenerator } from "./core/report.js";
import { ProductConfigSchema, ProductConfig, ProductMusicConfigSchema, ProductSlugRegex } from "./schemas/product.js";
import { AssetsRegistrySchema, AssetsRegistry, AssetItem } from "./schemas/assets.js";
import { Job, JobScopeSchema } from "./schemas/job.js";

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
const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");

// --- Security Middleware (FR-11) ---
// Dijalankan paling awal: sebelum body parser maupun static file.
function sendJsonError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  const body = details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  res.status(status).json(body);
}

function hostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    return trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.indexOf(":");
  const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon);
  return hostname.toLowerCase();
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  // Host harus persis loopback (bukan prefix, jadi 127.0.0.1.evil.com ditolak).
  const hostname = hostnameFromHostHeader(req.headers.host);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    sendJsonError(res, 403, "E_FORBIDDEN", "Akses hanya diizinkan melalui loopback 127.0.0.1");
    return;
  }

  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const isApiPath = req.path === "/api" || req.path.startsWith("/api/");

  if (isMutating && isApiPath) {
    if (firstHeaderValue(req.headers["x-app-request"]) !== "1") {
      sendJsonError(res, 403, "E_FORBIDDEN", "Header X-App-Request: 1 wajib disertakan");
      return;
    }

    const origin = firstHeaderValue(req.headers.origin);
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      sendJsonError(res, 403, "E_FORBIDDEN", "Origin tidak diizinkan");
      return;
    }

    const secFetchSite = firstHeaderValue(req.headers["sec-fetch-site"]);
    if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      sendJsonError(res, 403, "E_FORBIDDEN", "Permintaan lintas situs tidak diizinkan");
      return;
    }
  }

  next();
});

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, "public")));

// State in-memory
interface ActiveJob {
  job: Job;
  engine: RenderEngine;
  cancelPromise?: Promise<void>;
}

const activeJobs = new Map<string, ActiveJob>();
// Reservasi slug selama perencanaan agar dua POST render tidak lolos bersamaan.
const pendingRenders = new Set<string>();
// Reservasi slug selama render preview backsound agar tidak dobel klik.
const pendingPreviews = new Set<string>();
const sseClients = new Map<string, Set<Response>>();

function broadcastSSE(slug: string, event: string, data: unknown) {
  const clients = sseClients.get(slug);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    try {
      client.write(payload);
    } catch (err) {
      clients.delete(client);
      try {
        client.end();
      } catch {
        // ignore
      }
      console.error(`Gagal mengirim event SSE "${event}" untuk ${slug}:`, err);
    }
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

function ensureAssetFolders(product: ProductConfig): void {
  const { databaseDir } = getProductPaths(product.slug);
  for (const folder of ["hooks", "bodies", "ctas", "backsounds"]) {
    fs.mkdirSync(path.join(databaseDir, folder), { recursive: true });
  }
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
  return { schemaVersion: 1, specHash: "init", assets: { hook: {}, body: {}, cta: {}, music: {} } };
}

const ASSET_FOLDER_NAMES: Record<"hook" | "body" | "cta" | "music", string> = {
  hook: "hooks",
  body: "bodies",
  cta: "ctas",
  music: "backsounds",
};

function getAssetDiagnostics(product: ProductConfig, registry: AssetsRegistry) {
  const { databaseDir } = getProductPaths(product.slug);
  const missingByKind: Record<"hook" | "body" | "cta" | "music", number> = {
    hook: 0,
    body: 0,
    cta: 0,
    music: 0,
  };
  const missingKeys: { kind: "hook" | "body" | "cta" | "music"; file: string }[] = [];
  const folders: { kind: "hook" | "body" | "cta" | "music"; dirPath: string; readable: boolean }[] = [];
  let readable = true;

  for (const kind of ["hook", "body", "cta", "music"] as const) {
    const dirPath = path.join(databaseDir, ASSET_FOLDER_NAMES[kind]);
    let filesOnDisk: Set<string> | null = null;
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      // Pakai logika yang sama dengan scan/prune: hanya file aset valid yang dihitung.
      filesOnDisk = new Set(ScanEngine.listAssetFileNames(dirPath, kind));
      folders.push({ kind, dirPath, readable: true });
    } catch {
      readable = false;
      folders.push({ kind, dirPath, readable: false });
    }

    for (const file of Object.keys(registry.assets[kind])) {
      if (filesOnDisk && !filesOnDisk.has(file)) {
        missingByKind[kind] += 1;
        missingKeys.push({ kind, file });
      }
    }
  }

  return {
    readable,
    databaseDir,
    missingCount: missingKeys.length,
    missingByKind,
    missingKeys,
    folders,
  };
}

// Tulis JSON secara atomik: tmp file di direktori yang sama lalu rename.
function writeJsonAtomic(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

function resolveExistingProduct(rawSlug: string, res: Response): ProductConfig | null {
  if (!ProductSlugRegex.test(rawSlug)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Slug produk tidak valid");
    return null;
  }
  try {
    return loadProduct(rawSlug);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", `Produk tidak ditemukan: ${rawSlug}`);
    return null;
  }
}

// --- Background render runner (R1.1) ---
// Guard tambahan: jangan sampai request cancel menggantung jika cancelAndWait tidak menepati timeout.
async function waitForCancel(cancelAndWait: (timeoutMs?: number) => Promise<void>, timeoutMs: number): Promise<void> {
  const promise = cancelAndWait(timeoutMs);
  // Cegah unhandled rejection jika guard yang menang balapan.
  void promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs + 1000);
    timer.unref();
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Semua error ditangkap di sini supaya kegagalan background tidak mematikan server.
async function runJob(slug: string, handle: ActiveJob, product: ProductConfig, plan: PlanResult, manifest: Manifest): Promise<void> {
  const { job, engine } = handle;

  try {
    await engine.renderQueue(ROOT_DIR, product, plan.queue, manifest, job, {
      onItemDone: (filename, item, done, total) => {
        if (job.cancelled) return;
        broadcastSSE(slug, "item", { filename, item, done, total });
      },
      onItemFailed: (filename, error, done, total) => {
        if (job.cancelled) return;
        broadcastSSE(slug, "error", { filename, error, done, total });
      },
      onProgress: (done, total, current) => {
        if (job.cancelled) return;
        broadcastSSE(slug, "progress", { done, total, failed: job.failed, current });
      },
    });

    if (job.cancelled) {
      // Event `cancelled` dikirim oleh endpoint cancel, bukan di sini.
      job.status = "CANCELLED";
      job.current = null;
      if (!job.completedAt) job.completedAt = new Date().toISOString();
    } else {
      // Jangan menimpa status FAILED dari engine: kalau semua item gagal,
      // job harus tetap FAILED, bukan sukses palsu.
      job.status = job.failed > 0 && job.done === 0 ? "FAILED" : "DONE";
      job.current = null;
      job.completedAt = new Date().toISOString();
      broadcastSSE(slug, "done", { status: job.status, job });
    }
  } catch (err) {
    if (!job.completedAt) job.completedAt = new Date().toISOString();
    if (job.cancelled) {
      job.status = "CANCELLED";
      job.current = null;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      job.status = "FAILED";
      job.current = null;
      console.error(`[render] Job ${job.jobId} (${slug}) gagal:`, err);
      broadcastSSE(slug, "error", { code: "E_RENDER_FAILED", message, job });
      broadcastSSE(slug, "done", { status: "FAILED", job });
    }
  } finally {
    // Hanya hapus jika handle ini masih yang terdaftar (job baru tidak boleh terhapus).
    if (activeJobs.get(slug) === handle) {
      activeJobs.delete(slug);
    }
  }
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

// GET /api/capabilities - UI memakai ini untuk menampilkan fitur yang tersedia
// di server yang sedang berjalan (mencegah tombol baru memanggil endpoint lama).
app.get("/api/capabilities", (_req, res) => {
  res.json({ ok: true, musicPreview: true, musicTrackSettings: true });
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
          music: Object.keys(reg.assets.music).length,
        },
      };
    } catch {
      return { slug, displayName: slug, counts: { hooks: 0, bodies: 0, ctas: 0, music: 0 } };
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
    fs.mkdirSync(path.join(paths.databaseDir, "backsounds"), { recursive: true });
    fs.mkdirSync(paths.outputDir, { recursive: true });

    writeJsonAtomic(paths.configPath, parsed);
    res.status(201).json({ product: parsed });
  } catch (err) {
    res.status(400).json({ error: { code: "E_VALIDATION_ERROR", message: (err as Error).message } });
  }
});

// GET /api/products/:slug
app.get("/api/products/:slug", (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;
  try {
    ensureAssetFolders(product);
    const registry = loadRegistry(product.slug);
    const diagnostics = getAssetDiagnostics(product, registry);
    res.json({ product, registry, diagnostics });
  } catch (err) {
    sendJsonError(res, 500, "E_READ_FAILED", (err as Error).message);
  }
});

// PATCH /api/products/:slug - update konfigurasi backsound (dan field produk lain yang dikirim)
app.patch("/api/products/:slug", (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const slug = product.slug;
  if (activeJobs.has(slug) || pendingRenders.has(slug)) {
    sendJsonError(res, 409, "E_JOB_RUNNING", "Proses render sedang berlangsung untuk produk ini");
    return;
  }

  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJsonError(res, 400, "E_VALIDATION_ERROR", "Body harus berupa objek");
      return;
    }

    // Hanya music yang boleh diubah lewat endpoint ini. Field lain diabaikan
    // agar spec video/audio tidak berubah tanpa scan ulang.
    const musicPatch = body.music;
    if (!musicPatch || typeof musicPatch !== "object" || Array.isArray(musicPatch)) {
      sendJsonError(res, 400, "E_VALIDATION_ERROR", "Field music wajib dikirim sebagai objek");
      return;
    }

    const updated = ProductConfigSchema.parse({
      ...product,
      music: {
        ...product.music,
        ...musicPatch,
      },
    });

    writeJsonAtomic(getProductPaths(slug).configPath, updated);
    res.json({ product: updated });
  } catch (err) {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", (err as Error).message);
  }
});

// PATCH /api/products/:slug/assets/:kind/:file - enable/disable satu aset
app.patch("/api/products/:slug/assets/:kind/:file", (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const kind = req.params.kind;
  if (!["hook", "body", "cta", "music"].includes(kind)) {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Jenis aset tidak valid");
    return;
  }

  if (typeof req.body?.enabled !== "boolean") {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Field enabled harus boolean");
    return;
  }

  try {
    const registry = loadRegistry(product.slug);
    const bucket = registry.assets[kind as "hook" | "body" | "cta" | "music"];
    const item = bucket[req.params.file];
    if (!item) {
      sendJsonError(res, 404, "E_NOT_FOUND", "Aset tidak ditemukan");
      return;
    }

    item.enabled = req.body.enabled;
    writeJsonAtomic(getProductPaths(product.slug).assetsPath, registry);
    res.json({ ok: true, file: req.params.file, item });
  } catch (err) {
    sendJsonError(res, 500, "E_WRITE_FAILED", (err as Error).message);
  }
});

// POST /api/products/:slug/scan
app.post("/api/products/:slug/scan", async (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;
  try {
    const { registry, report } = await ScanEngine.scanProductAssetsDetailed(
      ROOT_DIR,
      product,
      loadRegistry(product.slug)
    );
    writeJsonAtomic(getProductPaths(product.slug).assetsPath, registry);
    const diagnostics = getAssetDiagnostics(product, registry);
    res.json({ ok: true, registry, report, diagnostics });
  } catch (err) {
    if (err instanceof ScanFolderUnreadableError) {
      sendJsonError(res, 500, "E_SCAN_FOLDER_UNREADABLE", err.message, {
        dirPath: err.dirPath,
        code: err.causeCode,
      });
      return;
    }
    sendJsonError(res, 500, "E_SCAN_FAILED", (err as Error).message);
  }
});

// POST /api/products/:slug/assets/prune-missing
app.post("/api/products/:slug/assets/prune-missing", (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const slug = product.slug;
  if (activeJobs.has(slug) || pendingRenders.has(slug)) {
    sendJsonError(res, 409, "E_JOB_RUNNING", "Proses render sedang berlangsung untuk produk ini");
    return;
  }

  try {
    const { registry, removed, skippedKinds } = ScanEngine.pruneMissingAssets(
      ROOT_DIR,
      product,
      loadRegistry(slug)
    );
    writeJsonAtomic(getProductPaths(slug).assetsPath, registry);
    if (removed.length > 0) {
      console.log(`[prune] ${slug}: ${removed.length} entri hilang dihapus`);
    }
    if (skippedKinds.length > 0) {
      console.log(`[prune] ${slug}: folder dilewati -> ${skippedKinds.join(", ")}`);
    }
    const diagnostics = getAssetDiagnostics(product, registry);
    res.json({ ok: true, removed, skippedKinds, registry, diagnostics });
  } catch (err) {
    sendJsonError(res, 500, "E_PRUNE_FAILED", (err as Error).message);
  }
});

// GET /api/products/:slug/plan
app.get("/api/products/:slug/plan", async (req, res) => {
  const scopeResult = JobScopeSchema.safeParse(req.query.scope ?? "new");
  if (!scopeResult.success) {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Nilai scope tidak valid (new|stale|all|subset)");
    return;
  }

  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  if (activeJobs.has(product.slug) || pendingRenders.has(product.slug)) {
    sendJsonError(res, 409, "E_JOB_RUNNING", "Proses render sedang berlangsung untuk produk ini");
    return;
  }

  try {
    const registry = loadRegistry(product.slug);
    const { outputDir } = getProductPaths(product.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scopeResult.data);
    res.json({ plan });
  } catch (err) {
    sendJsonError(res, 500, "E_PLAN_FAILED", (err as Error).message);
  }
});

// POST /api/products/:slug/render
app.post("/api/products/:slug/render", async (req, res) => {
  const scopeResult = JobScopeSchema.safeParse(req.body?.scope ?? "new");
  if (!scopeResult.success) {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Nilai scope tidak valid (new|stale|all|subset)");
    return;
  }

  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const slug = product.slug;
  if (activeJobs.has(slug) || pendingRenders.has(slug)) {
    sendJsonError(res, 409, "E_JOB_RUNNING", "Proses render sedang berlangsung untuk produk ini");
    return;
  }

  pendingRenders.add(slug);
  try {
    const registry = loadRegistry(slug);
    const { outputDir } = getProductPaths(slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const plan = await PlanEngine.createPlan(ROOT_DIR, product, registry, manifest, scopeResult.data);

    if (plan.blockers.length > 0) {
      sendJsonError(
        res,
        422,
        "E_LIMIT_EXCEEDED",
        "Rencana render melebihi batas aman. Kurangi kombinasi sebelum render.",
        plan.blockers
      );
      return;
    }

    if (plan.counts.queued === 0) {
      sendJsonError(res, 422, "E_NO_ITEMS", "Tidak ada video baru dalam antrean render");
      return;
    }

    // Setelah upgrade nama cache ingest (specHash), cache lama belum punya file
    // kanonik baru. Jangan menulis FAILED per item; minta scan ulang sekali.
    const missingNormalizedCache = plan.queue.some((combo) => {
      const videoMissing = [combo.hookItem, combo.bodyItem, combo.ctaItem].some(
        (item) =>
          !fs.existsSync(
            IngestEngine.getNormalizedCachePath(ROOT_DIR, product, item.sha256, item.slug)
          )
      );
      const musicMissing =
        combo.musicItem !== null &&
        combo.musicItem !== undefined &&
        !fs.existsSync(
          IngestEngine.getMusicCachePath(
            ROOT_DIR,
            product,
            combo.musicItem.sha256,
            combo.musicItem.slug
          )
        );
      return videoMissing || musicMissing;
    });
    if (missingNormalizedCache) {
      sendJsonError(
        res,
        422,
        "E_SCAN_REQUIRED",
        "Cache normalisasi untuk spesifikasi terbaru belum siap. Jalankan Pindai Ulang sekali, lalu render lagi."
      );
      return;
    }

    const job: Job = {
      jobId: `job_${Date.now()}`,
      product: slug,
      status: "RUNNING",
      scope: scopeResult.data,
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
    const handle: ActiveJob = { job, engine };
    activeJobs.set(slug, handle);

    // Mulai setelah response 202 terkirim, agar kegagalan awal engine
    // (mis. mkdir gagal) tidak mendahului response dan tidak mematikan server.
    setImmediate(() => {
      void runJob(slug, handle, product, plan, manifest).catch((err) => {
        console.error(`[render] Kegagalan tak terduga pada job ${job.jobId} (${slug}):`, err);
      });
    });

    res.status(202).json({ job });
  } catch (err) {
    sendJsonError(res, 500, "E_RENDER_ERROR", (err as Error).message);
  } finally {
    pendingRenders.delete(slug);
  }
});

// POST /api/products/:slug/render/cancel
app.post("/api/products/:slug/render/cancel", async (req, res) => {
  const slug = getProductPaths(req.params.slug).slug;
  const handle = activeJobs.get(slug);
  if (!handle) {
    sendJsonError(res, 404, "E_NOT_FOUND", "Tidak ada proses render yang sedang aktif");
    return;
  }

  // Tandai batal dulu agar callback/runJob tidak lagi mengirim event progres maupun `done`.
  handle.job.cancelled = true;

  if (!handle.cancelPromise) {
    handle.cancelPromise = (async () => {
      const engine = handle.engine as RenderEngine & { cancelAndWait?: (timeoutMs?: number) => Promise<void> };
      try {
        if (typeof engine.cancelAndWait === "function") {
          // Preflight ffprobe punya timeout internal sampai 30 detik; jangan lepas lock lebih awal.
          await waitForCancel(engine.cancelAndWait.bind(engine), 30000);
        } else {
          engine.cancel();
        }
      } catch (err) {
        console.error(`[render] cancelAndWait untuk ${slug} gagal/timeout:`, err);
      }

      handle.job.status = "CANCELLED";
      handle.job.current = null;
      if (!handle.job.completedAt) handle.job.completedAt = new Date().toISOString();

      if (activeJobs.get(slug) === handle) {
        activeJobs.delete(slug);
      }

      // Hanya event `cancelled`; tidak ada `done` untuk job yang dibatalkan.
      broadcastSSE(slug, "cancelled", { job: handle.job });
    })();
  }

  // Permintaan cancel ganda menunggu promise yang sama (tanpa event ganda).
  await handle.cancelPromise;

  res.status(202).json({ ok: true, job: handle.job });
});

// GET /api/products/:slug/job
app.get("/api/products/:slug/job", (req, res) => {
  const active = activeJobs.get(getProductPaths(req.params.slug).slug);
  if (active) {
    res.json({ job: active.job });
  } else {
    res.json({ job: null });
  }
});

// GET /api/products/:slug/events (SSE)
app.get("/api/products/:slug/events", (req, res) => {
  const slug = getProductPaths(req.params.slug).slug;
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
  try {
    res.write(`event: snapshot\ndata: ${JSON.stringify({ job: active?.job || null })}\n\n`);
  } catch (err) {
    console.error(`Gagal mengirim snapshot SSE untuk ${slug}:`, err);
  }

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      sseClients.get(slug)?.delete(res);
      return;
    }
    try {
      res.write(`event: heartbeat\ndata: {}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
      sseClients.get(slug)?.delete(res);
      console.error(`Gagal mengirim heartbeat SSE untuk ${slug}:`, err);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(slug)?.delete(res);
  });
});

// GET /api/products/:slug/report.csv
app.get("/api/products/:slug/report.csv", (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;
  try {
    const { outputDir } = getProductPaths(product.slug);
    const manifest = ManifestManager.loadManifest(outputDir, product);
    const csvContent = ReportGenerator.generateCsv(manifest, product);

    // Nama file untuk header hanya boleh berisi slug yang sudah tervalidasi.
    const safeName = product.slug.replace(/[^a-z0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="report_${safeName}.csv"`);
    res.send(csvContent);
  } catch (err) {
    sendJsonError(res, 500, "E_REPORT_FAILED", (err as Error).message);
  }
});

// --- Folder reveal endpoints (F1.x) ---

const FOLDER_OPEN_DEDUPE_MS = 1000;
const FOLDER_OPEN_TIMEOUT_MS = 2000;
const lastFolderOpen = new Map<string, number>();

function pruneFolderOpenLog(now: number): void {
  for (const [key, timestamp] of lastFolderOpen) {
    if (now - timestamp > 60_000) {
      lastFolderOpen.delete(key);
    }
  }
}

// Resolve saat Explorer benar-benar berhasil di-spawn (bukan berdasarkan exit code).
function safeOpenFolder(targetDir: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const winPath = path.resolve(targetDir).replace(/\//g, "\\");
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn("explorer.exe", [winPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    const settle = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(err);
        return;
      }
      child.unref();
      resolve(child.pid ?? 0);
    };

    timer = setTimeout(() => {
      settle(new Error(`Timeout ${FOLDER_OPEN_TIMEOUT_MS} ms saat membuka File Explorer`));
    }, FOLDER_OPEN_TIMEOUT_MS);

    child.once("spawn", () => settle(null));
    child.once("error", (err) => {
      settle(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function openExistingFolder(res: Response, targetDir: string): Promise<void> {
  const resolved = path.resolve(targetDir);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    sendJsonError(res, 404, "E_PATH_INVALID", "Folder tidak ditemukan");
    return;
  }
  if (!stat.isDirectory()) {
    sendJsonError(res, 404, "E_PATH_INVALID", "Path bukan folder");
    return;
  }

  const now = Date.now();
  pruneFolderOpenLog(now);
  const last = lastFolderOpen.get(resolved);
  if (last !== undefined && now - last < FOLDER_OPEN_DEDUPE_MS) {
    res.json({ ok: true, path: resolved, deduped: true });
    return;
  }
  lastFolderOpen.set(resolved, now);

  try {
    const pid = await safeOpenFolder(resolved);
    res.json({ ok: true, path: resolved, pid });
  } catch (err) {
    // Izinkan percobaan ulang segera setelah gagal.
    lastFolderOpen.delete(resolved);
    console.error(`[open-folder] Gagal membuka folder "${resolved}":`, err);
    sendJsonError(res, 500, "E_OPEN_FAILED", `Gagal membuka folder: ${(err as Error).message}`);
  }
}

// POST /api/products/:slug/open-output
app.post("/api/products/:slug/open-output", async (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;
  const { outputDir } = getProductPaths(product.slug);
  await openExistingFolder(res, outputDir);
});

// POST /api/products/:slug/open-database
app.post("/api/products/:slug/open-database", async (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const rawKind = req.query.kind;
  let kind: string | undefined;
  if (rawKind === undefined) {
    kind = undefined;
  } else if (typeof rawKind === "string") {
    const trimmed = rawKind.trim();
    kind = trimmed === "" ? undefined : trimmed;
  } else {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Parameter kind tidak valid");
    return;
  }

  if (kind !== undefined && !["hooks", "bodies", "ctas", "backsounds"].includes(kind)) {
    sendJsonError(res, 400, "E_VALIDATION_ERROR", "Nilai kind harus hooks, bodies, ctas, atau backsounds");
    return;
  }

  const { databaseDir } = getProductPaths(product.slug);
  const targetDir = kind ? path.join(databaseDir, kind) : databaseDir;
  await openExistingFolder(res, targetDir);
});

// --- Media Range Streaming (FR-8) ---

const MEDIA_FOLDERS: Record<string, string> = {
  hook: "hooks",
  body: "bodies",
  cta: "ctas",
  music: "backsounds",
};

// Mengembalikan null jika header Range tidak valid / tidak bisa dipenuhi (-> 416).
function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return null;
  if (fileSize <= 0) return null;

  if (!rawStart) {
    // Suffix range: bytes=-N (N byte terakhir)
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= fileSize) return null;

  let end: number;
  if (!rawEnd) {
    end = fileSize - 1;
  } else {
    end = Number(rawEnd);
    if (!Number.isSafeInteger(end) || end < start) return null;
  }
  if (end >= fileSize) end = fileSize - 1;

  return { start, end };
}

function streamFileToResponse(
  res: Response,
  filePath: string,
  status: number,
  headers: Record<string, string | number>,
  range?: { start: number; end: number }
): void {
  res.writeHead(status, headers);
  const stream = range ? fs.createReadStream(filePath, range) : fs.createReadStream(filePath);
  let completed = false;

  stream.on("error", (err) => {
    completed = true;
    console.error(`Gagal membaca file media "${filePath}":`, err);
    if (!res.headersSent) {
      sendJsonError(res, 500, "E_MEDIA_READ_FAILED", "Gagal membaca file media");
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  stream.on("end", () => {
    completed = true;
  });

  // Jangan biarkan stream menggantung saat klien memutus koneksi.
  res.on("close", () => {
    if (!completed) stream.destroy();
  });

  stream.pipe(res);
}

app.get("/api/products/:slug/media/:kind/:file", (req, res) => {
  const rawSlug = req.params.slug;
  const kind = req.params.kind;
  const rawFile = req.params.file;

  if (!ProductSlugRegex.test(rawSlug)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Slug produk tidak valid");
    return;
  }

  let product: ProductConfig;
  try {
    product = loadProduct(rawSlug);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", `Produk tidak ditemukan: ${rawSlug}`);
    return;
  }

  const folder = MEDIA_FOLDERS[kind];
  if (!folder) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Jenis media tidak valid");
    return;
  }

  if (
    !rawFile ||
    rawFile === "." ||
    rawFile === ".." ||
    rawFile.includes("/") ||
    rawFile.includes("\\") ||
    rawFile.includes("\0") ||
    path.basename(rawFile) !== rawFile
  ) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Nama file tidak valid");
    return;
  }

  const folderDir = path.resolve(ROOT_DIR, "database", product.slug, folder);
  const candidate = path.resolve(folderDir, rawFile);
  if (!candidate.startsWith(folderDir + path.sep)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Path file tidak valid");
    return;
  }

  // Lindungi dari symlink/junction yang keluar dari folder media.
  let realFolder: string;
  let realFile: string;
  try {
    realFolder = fs.realpathSync(folderDir);
    realFile = fs.realpathSync(candidate);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", "File media tidak ditemukan");
    return;
  }
  if (!realFile.startsWith(realFolder + path.sep)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Path file tidak valid");
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", "File media tidak ditemukan");
    return;
  }
  if (!stat.isFile()) {
    sendJsonError(res, 404, "E_NOT_FOUND", "File media tidak ditemukan");
    return;
  }

  const fileSize = stat.size;
  const ext = path.extname(realFile).toLowerCase();
  const audioContentTypes: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  // Backsound boleh berupa audio dalam kontainer MP4; kirim sebagai audio/mp4
  // agar browser memutarnya lewat elemen <audio>. Folder video tetap video/mp4.
  const contentType = kind === "music" ? (audioContentTypes[ext] ?? "audio/mp4") : "video/mp4";
  const rangeHeader = req.headers.range;

  if (typeof rangeHeader === "string" && rangeHeader !== "") {
    const parsedRange = parseRangeHeader(rangeHeader, fileSize);
    if (!parsedRange) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      res.setHeader("Accept-Ranges", "bytes");
      sendJsonError(res, 416, "E_RANGE_INVALID", "Rentang byte tidak valid");
      return;
    }

    const { start, end } = parsedRange;
    streamFileToResponse(
      res,
      realFile,
      206,
      {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      },
      { start, end }
    );
    return;
  }

  streamFileToResponse(res, realFile, 200, {
    "Content-Length": fileSize,
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
  });
});

// --- Preview backsound (Tes Hasil) ---

function firstReadyAsset(bucket: Record<string, AssetItem>): [string, AssetItem] | null {
  return Object.entries(bucket).find(([, item]) => item.enabled && item.status === "READY") ?? null;
}

/** Simpan beberapa preview terakhir; file lama yang masih diputar browser dilewati jika terkunci. */
function cleanupOldPreviews(dir: string, keepName: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^preview(?:-[a-z0-9-]+)?\.mp4$/i.test(name) && name !== keepName)
      .map((name) => {
        try {
          return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of files.slice(4)) {
      try {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      } catch {
        // Biarkan jika browser masih memegang file.
      }
    }
  } catch {
    // Cleanup best-effort.
  }
}

// POST /api/products/:slug/music/preview
// Render satu video contoh dengan konfigurasi backsound dari form (tanpa menyimpan).
app.post("/api/products/:slug/music/preview", async (req, res) => {
  const product = resolveExistingProduct(req.params.slug, res);
  if (!product) return;

  const slug = product.slug;
  if (activeJobs.has(slug) || pendingRenders.has(slug)) {
    sendJsonError(res, 409, "E_JOB_RUNNING", "Tunggu render yang sedang berjalan selesai sebelum tes backsound");
    return;
  }
  if (pendingPreviews.has(slug)) {
    sendJsonError(res, 409, "E_PREVIEW_RUNNING", "Tes backsound sedang diproses. Tunggu sebentar.");
    return;
  }

  pendingPreviews.add(slug);
  try {
    const registry = loadRegistry(slug);
    const musicTracks = Object.entries(registry.assets.music)
      .filter(([, item]) => item.status === "READY");

    if (musicTracks.length === 0) {
      sendJsonError(
        res,
        422,
        "E_NO_MUSIC",
        "Belum ada backsound READY. Tambahkan file lalu klik Pindai Ulang."
      );
      return;
    }

    const requestedTrack = typeof req.body?.track === "string" ? req.body.track : "";
    let selectedTrack: [string, AssetItem] | undefined;
    if (requestedTrack) {
      selectedTrack = musicTracks.find(([file]) => file === requestedTrack);
      if (!selectedTrack) {
        sendJsonError(res, 400, "E_VALIDATION_ERROR", "Track backsound tidak ditemukan atau belum READY");
        return;
      }
    } else {
      const fixed = product.music.fixedFile
        ? musicTracks.find(([file]) => file === product.music.fixedFile)
        : undefined;
      selectedTrack = fixed ?? musicTracks[0]!;
    }

    const hook = firstReadyAsset(registry.assets.hook);
    const body = firstReadyAsset(registry.assets.body);
    const cta = firstReadyAsset(registry.assets.cta);
    if (!hook || !body || !cta) {
      sendJsonError(res, 422, "E_NO_ASSETS", "Butuh minimal satu hook, body, dan CTA READY untuk tes backsound");
      return;
    }

    const music = ProductMusicConfigSchema.parse({
      ...product.music,
      ...(req.body?.music && typeof req.body.music === "object" && !Array.isArray(req.body.music)
        ? req.body.music
        : {}),
      // Preview selalu mencampur backsound, walaupun checkbox "Aktifkan" sedang dimatikan.
      enabled: true,
    });
    const previewProduct = ProductConfigSchema.parse({ ...product, music });

    const combo: PlanCombination = {
      key: "preview",
      filename: "preview.mp4",
      hookFile: hook[0],
      bodyFile: body[0],
      ctaFile: cta[0],
      hookItem: hook[1],
      bodyItem: body[1],
      ctaItem: cta[1],
      status: "QUEUED",
      musicFile: selectedTrack[0],
      musicItem: selectedTrack[1],
    };

    const previewDir = path.join(ROOT_DIR, "cache", slug, "preview");
    fs.mkdirSync(previewDir, { recursive: true });
    const previewName = `preview-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.mp4`;
    const outputPath = path.join(previewDir, previewName);

    const engine = new RenderEngine();
    const result = await engine.renderPreview(ROOT_DIR, previewProduct, combo, outputPath);
    cleanupOldPreviews(previewDir, previewName);

    res.json({
      ok: true,
      url: `/api/products/${slug}/music/preview/${encodeURIComponent(previewName)}?t=${Date.now()}`,
      track: selectedTrack[0],
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
      combo: { hook: hook[0], body: body[0], cta: cta[0] },
      music: {
        volume: music.tracks[selectedTrack[0]]?.volume ?? music.volume,
        defaultVolume: music.volume,
        startSeconds: music.tracks[selectedTrack[0]]?.startSeconds ?? 0,
        endSeconds: music.tracks[selectedTrack[0]]?.endSeconds ?? null,
        fadeInSeconds: music.fadeInSeconds,
        fadeOutSeconds: music.fadeOutSeconds,
        loop: music.loop,
      },
    });
  } catch (err) {
    sendJsonError(res, 500, "E_PREVIEW_FAILED", (err as Error).message);
  } finally {
    pendingPreviews.delete(slug);
  }
});

// GET /api/products/:slug/music/preview/:file
app.get("/api/products/:slug/music/preview/:file", (req, res) => {
  const rawSlug = req.params.slug;
  if (!ProductSlugRegex.test(rawSlug)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Slug produk tidak valid");
    return;
  }

  let product: ProductConfig;
  try {
    product = loadProduct(rawSlug);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", `Produk tidak ditemukan: ${rawSlug}`);
    return;
  }

  const rawFile = req.params.file;
  if (!rawFile || !/^preview(?:-[a-z0-9-]+)?\.mp4$/i.test(rawFile)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Nama file preview tidak valid");
    return;
  }

  const previewDir = path.resolve(ROOT_DIR, "cache", product.slug, "preview");
  const filePath = path.resolve(previewDir, rawFile);
  if (!filePath.startsWith(previewDir + path.sep)) {
    sendJsonError(res, 400, "E_PATH_INVALID", "Path preview tidak valid");
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJsonError(res, 404, "E_NOT_FOUND", "Preview backsound belum dibuat");
    return;
  }
  if (!stat.isFile()) {
    sendJsonError(res, 404, "E_NOT_FOUND", "Preview backsound tidak ditemukan");
    return;
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");

  if (typeof rangeHeader === "string" && rangeHeader !== "") {
    const parsedRange = parseRangeHeader(rangeHeader, fileSize);
    if (!parsedRange) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      sendJsonError(res, 416, "E_RANGE_INVALID", "Rentang byte tidak valid");
      return;
    }

    const { start, end } = parsedRange;
    streamFileToResponse(
      res,
      filePath,
      206,
      {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store",
      },
      { start, end }
    );
    return;
  }

  streamFileToResponse(res, filePath, 200, {
    "Content-Length": fileSize,
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
  });
});

// --- Fallback 404 JSON untuk /api/* ---
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    sendJsonError(res, 404, "E_NOT_FOUND", `Endpoint tidak ditemukan: ${req.method} ${req.path}`);
    return;
  }
  next();
});

// --- Error middleware JSON ---
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status = 500;
  let code = "E_INTERNAL";
  let message = "Terjadi kesalahan internal pada server";

  if (err && typeof err === "object") {
    const anyErr = err as { type?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
    const errType = typeof anyErr.type === "string" ? anyErr.type : undefined;

    if (errType === "entity.parse.failed") {
      status = 400;
      code = "E_VALIDATION_ERROR";
      message = "Body JSON tidak valid";
    } else if (errType === "entity.too.large") {
      status = 413;
      code = "E_UPLOAD_TOO_LARGE";
      message = "Ukuran body permintaan terlalu besar";
    } else {
      if (typeof anyErr.status === "number") status = anyErr.status;
      else if (typeof anyErr.statusCode === "number") status = anyErr.statusCode;

      if (typeof anyErr.code === "string" && /^E_[A-Z0-9_]+$/.test(anyErr.code)) {
        code = anyErr.code;
      } else if (status === 400) {
        code = "E_VALIDATION_ERROR";
      } else if (status === 404) {
        code = "E_NOT_FOUND";
      } else if (status === 403) {
        code = "E_FORBIDDEN";
      }

      if (typeof anyErr.message === "string" && anyErr.message) message = anyErr.message;
    }
  }

  // Log ringkas untuk error 4xx (mis. body JSON rusak), stack lengkap untuk 5xx.
  if (status >= 500) {
    console.error(`[server] Error pada ${req.method} ${req.originalUrl}:`, err);
  } else {
    console.warn(`[server] ${status} pada ${req.method} ${req.originalUrl}: ${message}`);
  }

  res.status(status).json({ error: { code, message } });
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
