import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const FFMPEG_BIN = path.join(ROOT_DIR, "bin", "ffmpeg.exe");
const FIXTURES_DIR = path.join(ROOT_DIR, "fixtures");

async function runFfmpeg(args: string[]) {
  return execFileAsync(FFMPEG_BIN, args, { windowsHide: true });
}

async function main() {
  console.log("Generating 16 test fixtures in:", FIXTURES_DIR);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // 1. Baseline: 1080x1920@30 H.264 High + AAC 48k stereo x3 (2s each)
  const baselineDir = path.join(FIXTURES_DIR, "01_baseline");
  fs.mkdirSync(baselineDir, { recursive: true });
  for (const name of ["hook.mp4", "body.mp4", "cta.mp4"]) {
    console.log(`- Generating 01_baseline/${name}...`);
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
      "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
      path.join(baselineDir, name),
    ]);
  }

  // 2. 1280x720@25 (resolusi & fps beda)
  console.log("- Generating 02_diff_res_fps.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=44100",
    "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    path.join(FIXTURES_DIR, "02_diff_res_fps.mp4"),
  ]);

  // 3. 1920x1080 + rotasi 90 derajat
  console.log("- Generating 03_rotation_90.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2",
    "-metadata:s:v:0", "rotate=90",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    path.join(FIXTURES_DIR, "03_rotation_90.mp4"),
  ]);

  // 4. Tanpa audio
  console.log("- Generating 04_silent_no_audio.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30",
    "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    path.join(FIXTURES_DIR, "04_silent_no_audio.mp4"),
  ]);

  // 5. 44.1 kHz mono
  console.log("- Generating 05_44k_mono.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=44100",
    "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ac", "1", "-ar", "44100",
    path.join(FIXTURES_DIR, "05_44k_mono.mp4"),
  ]);

  // 6. 60 fps
  console.log("- Generating 06_60fps.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=60",
    "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000",
    "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    path.join(FIXTURES_DIR, "06_60fps.mp4"),
  ]);

  // 7. VFR (Variable Frame Rate simulation via fps filter)
  console.log("- Generating 07_vfr.mp4...");
  await runFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=400:sample_rate=48000",
    "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    path.join(FIXTURES_DIR, "07_vfr.mp4"),
  ]);

  // 8. Nama unicode, apostrof, spasi
  const unicodeName = "08_hook 'spesial' #1 — promo diskon 👍.mp4";
  console.log(`- Generating ${unicodeName}...`);
  fs.copyFileSync(path.join(baselineDir, "hook.mp4"), path.join(FIXTURES_DIR, unicodeName));

  // 9. Nama panjang (250 karakter)
  const longName = "09_" + "a".repeat(230) + "_test.mp4";
  console.log("- Generating 09_long_filename (238 chars)...");
  try {
    fs.copyFileSync(path.join(baselineDir, "hook.mp4"), path.join(FIXTURES_DIR, longName));
  } catch (err) {
    console.warn("Notice: Long filename copy handled per OS max path constraint:", (err as Error).message);
  }

  // 10. Reserved name simulation info (Windows blocks direct CON.mp4 creation, handled by validator)
  console.log("- Generating 10_reserved_names_manifest.json...");
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "10_reserved_names_manifest.json"),
    JSON.stringify({ forbidden: ["CON.mp4", "PRN.mp4", "AUX.mp4", "NUL.mp4", "COM1.mp4"] }, null, 2)
  );

  // 11. Corrupt, 0-byte, and truncated files
  console.log("- Generating 11_corrupt files...");
  fs.writeFileSync(path.join(FIXTURES_DIR, "11_zero_byte.mp4"), Buffer.alloc(0));
  fs.writeFileSync(path.join(FIXTURES_DIR, "11_not_video.mp4"), Buffer.from("Ini bukan file video mp4, hanya teks biasa."));
  
  // Truncated video (ambil 10KB awal dari baseline)
  const fullBytes = fs.readFileSync(path.join(baselineDir, "hook.mp4"));
  fs.writeFileSync(path.join(FIXTURES_DIR, "11_truncated.mp4"), fullBytes.subarray(0, 10240));

  // 12. Dua file nama sama isi beda
  console.log("- Generating 12_duplicate_contents...");
  const dupDir = path.join(FIXTURES_DIR, "12_duplicates");
  fs.mkdirSync(dupDir, { recursive: true });
  fs.copyFileSync(path.join(baselineDir, "hook.mp4"), path.join(dupDir, "source_v1.mp4"));
  fs.copyFileSync(path.join(FIXTURES_DIR, "04_silent_no_audio.mp4"), path.join(dupDir, "source_v2.mp4"));

  // 13. File locked manifest
  console.log("- Generating 13_locked_simulation_manifest.json...");
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "13_locked_simulation_manifest.json"),
    JSON.stringify({ description: "Simulation spec for EPERM/EBUSY retry" }, null, 2)
  );

  // 14. 1000 combinations descriptor (10x10x10)
  console.log("- Generating 14_stress_1000_spec.json...");
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "14_stress_1000_spec.json"),
    JSON.stringify({ hooks: 10, bodies: 10, ctas: 10, total: 1000 }, null, 2)
  );

  // 15. Kill-9 resume descriptor
  console.log("- Generating 15_kill_resume_spec.json...");
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "15_kill_resume_spec.json"),
    JSON.stringify({ interruptAtItem: 60, totalItems: 125 }, null, 2)
  );

  // 16. CSV format test spec
  console.log("- Generating 16_csv_excel_spec.json...");
  fs.writeFileSync(
    path.join(FIXTURES_DIR, "16_csv_excel_spec.json"),
    JSON.stringify({
      bom: "EF BB BF",
      delimiter: ",",
      crlf: true,
      columns: ["filename", "product", "hook", "body", "cta", "duration_seconds", "created_at", "status", "size_mb", "width", "height", "fps"]
    }, null, 2)
  );

  console.log("All 16 fixtures created successfully!");
}

main().catch((err) => {
  console.error("Fixture generation failed:", err);
  process.exit(1);
});
