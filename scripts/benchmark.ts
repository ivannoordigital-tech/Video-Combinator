import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const FFMPEG_BIN = path.join(ROOT_DIR, "bin", "ffmpeg.exe");
const BENCH_DIR = path.join(ROOT_DIR, "cache", "benchmark");

async function runFfmpeg(args: string[]) {
  return execFileAsync(FFMPEG_BIN, args, { windowsHide: true });
}

async function main() {
  console.log("=== Video Combinator v2: Benchmark Harness ===");
  fs.mkdirSync(BENCH_DIR, { recursive: true });

  const clipsDir = path.join(BENCH_DIR, "clips");
  const outDir = path.join(BENCH_DIR, "outputs");
  const partsDir = path.join(outDir, ".parts");
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(partsDir, { recursive: true });

  // 1. Siapkan 5 Hooks, 5 Bodies, 5 CTAs (1s each synthetic clips)
  console.log("1. Preparing synthetic clips (5 hooks, 5 bodies, 5 CTAs)...");
  const t0_prep = performance.now();
  
  const hooks: string[] = [];
  const bodies: string[] = [];
  const ctas: string[] = [];

  for (let i = 1; i <= 5; i++) {
    const h = path.join(clipsDir, `h${i}.mp4`);
    const b = path.join(clipsDir, `b${i}.mp4`);
    const c = path.join(clipsDir, `c${i}.mp4`);
    
    if (!fs.existsSync(h)) {
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=1080x1920:rate=30`,
        "-f", "lavfi", "-i", `sine=frequency=${400 + i * 50}:sample_rate=48000`,
        "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        h
      ]);
    }
    if (!fs.existsSync(b)) {
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=1080x1920:rate=30`,
        "-f", "lavfi", "-i", `sine=frequency=${600 + i * 50}:sample_rate=48000`,
        "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        b
      ]);
    }
    if (!fs.existsSync(c)) {
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=1080x1920:rate=30`,
        "-f", "lavfi", "-i", `sine=frequency=${800 + i * 50}:sample_rate=48000`,
        "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        c
      ]);
    }
    hooks.push(h);
    bodies.push(b);
    ctas.push(c);
  }
  const t_prep = performance.now() - t0_prep;
  console.log(`Clips ready in ${(t_prep / 1000).toFixed(2)}s`);

  // 2. Planning phase (Cartesian product 5x5x5 = 125)
  console.log("2. Measuring Cartesian Plan (5x5x5 = 125 combinations)...");
  const t0_plan = performance.now();
  const combinations: { h: string; b: string; c: string; name: string }[] = [];
  for (let hi = 0; hi < hooks.length; hi++) {
    for (let bi = 0; bi < bodies.length; bi++) {
      for (let ci = 0; ci < ctas.length; ci++) {
        combinations.push({
          h: hooks[hi]!,
          b: bodies[bi]!,
          c: ctas[ci]!,
          name: `bench__h${hi + 1}__b${bi + 1}__c${ci + 1}.mp4`,
        });
      }
    }
  }
  const t_plan = performance.now() - t0_plan;
  console.log(`Plan completed in ${t_plan.toFixed(2)}ms for ${combinations.length} items`);

  // 3. Render phase (Fast Concat Copy with 3 concurrent workers)
  console.log("3. Rendering 125 videos using FFmpeg Stream Copy (concurrency: 3)...");
  const concurrency = 3;
  let completed = 0;
  const t0_render = performance.now();

  async function renderItem(item: { h: string; b: string; c: string; name: string }) {
    const listFile = path.join(partsDir, `${item.name}.list`);
    const partFile = path.join(partsDir, `${item.name}.part`);
    const finalFile = path.join(outDir, item.name);

    // List file format (slash path, no BOM)
    const listContent = `file '${item.h.replace(/\\/g, "/")}'\nfile '${item.b.replace(/\\/g, "/")}'\nfile '${item.c.replace(/\\/g, "/")}'\n`;
    fs.writeFileSync(listFile, listContent, "utf-8");

    // FFmpeg concat copy
    await runFfmpeg([
      "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart",
      "-f", "mp4", partFile,
    ]);

    // Atomic rename
    fs.renameSync(partFile, finalFile);
    fs.unlinkSync(listFile);
    completed++;
    if (completed % 25 === 0 || completed === combinations.length) {
      process.stdout.write(`  Rendered ${completed}/${combinations.length}...\n`);
    }
  }

  // Worker queue pool
  const queue = [...combinations];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        await renderItem(item);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const t_render = performance.now() - t0_render;
  const mem = process.memoryUsage();

  console.log("\n=== Benchmark Results ===");
  console.log(`Total Videos Rendered : ${completed}`);
  console.log(`Total Render Time     : ${(t_render / 1000).toFixed(2)} detik`);
  console.log(`Throughput            : ${(completed / (t_render / 1000)).toFixed(2)} video / detik`);
  console.log(`Rata-rata per Video   : ${(t_render / completed).toFixed(2)} ms / video`);
  console.log(`Target NFR            : ≤ 90 detik untuk 125 video (${(t_render / 1000) <= 90 ? "PASSED ✅" : "FAILED ❌"})`);
  console.log(`Memory RSS            : ${(mem.rss / 1024 / 1024).toFixed(2)} MB (Target ≤ 250 MB: ${mem.rss / 1024 / 1024 <= 250 ? "PASSED ✅" : "FAILED ❌"})`);

  // Cleanup benchmark output
  fs.rmSync(BENCH_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
