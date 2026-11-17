import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const FFMPEG_BIN = path.join(ROOT_DIR, "bin", "ffmpeg.exe");

// Target trial product directory
const TARGET_DIR = path.join(ROOT_DIR, "database", "produk-trial");
const HOOKS_DIR = path.join(TARGET_DIR, "hooks");
const BODIES_DIR = path.join(TARGET_DIR, "bodies");
const CTAS_DIR = path.join(TARGET_DIR, "ctas");

interface ClipSpec {
  folder: string;
  filename: string;
  tag: string;
  title: string;
  desc: string;
  colorHex: string;
  toneFreq: number;
}

const CLIPS: ClipSpec[] = [
  // --- 3 HOOKS ---
  {
    folder: HOOKS_DIR,
    filename: "hook1.mp4",
    tag: "HOOK 1",
    title: "Kaki Sering Pegal Saat Kerja?",
    desc: "Visual Hook Pembuka (3 Detik)",
    colorHex: "0xea580c", // Orange
    toneFreq: 440,
  },
  {
    folder: HOOKS_DIR,
    filename: "hook2.mp4",
    tag: "HOOK 2",
    title: "Cari Sepatu Stylish Tapi Empuk?",
    desc: "Visual Hook Pembuka (3 Detik)",
    colorHex: "0x7c3aed", // Purple
    toneFreq: 520,
  },
  {
    folder: HOOKS_DIR,
    filename: "hook3.mp4",
    tag: "HOOK 3",
    title: "Rahasia Nyaman Berdiri Seharian!",
    desc: "Visual Hook Pembuka (3 Detik)",
    colorHex: "0x0284c7", // Blue
    toneFreq: 600,
  },

  // --- 3 BODIES ---
  {
    folder: BODIES_DIR,
    filename: "body1.mp4",
    tag: "BODY 1",
    title: "Bantalan Memory Foam Ekstra Empuk",
    desc: "Fitur & Manfaat Utama (3 Detik)",
    colorHex: "0x059669", // Emerald Green
    toneFreq: 480,
  },
  {
    folder: BODIES_DIR,
    filename: "body2.mp4",
    tag: "BODY 2",
    title: "Bahan Mesh Bernapas Anti-Gerah",
    desc: "Fitur & Manfaat Utama (3 Detik)",
    colorHex: "0x0d9488", // Teal
    toneFreq: 560,
  },
  {
    folder: BODIES_DIR,
    filename: "body3.mp4",
    tag: "BODY 3",
    title: "Super Ringan Cuma 200 Gram",
    desc: "Fitur & Manfaat Utama (3 Detik)",
    colorHex: "0x4f46e5", // Indigo
    toneFreq: 640,
  },

  // --- 3 CTAS ---
  {
    folder: CTAS_DIR,
    filename: "cta1.mp4",
    tag: "CTA 1",
    title: "Diskon 50 Persen Hari Ini!",
    desc: "Ajakan Bertindak (3 Detik)",
    colorHex: "0xdc2626", // Red
    toneFreq: 700,
  },
  {
    folder: CTAS_DIR,
    filename: "cta2.mp4",
    tag: "CTA 2",
    title: "Klik Keranjang Kuning Sekarang!",
    desc: "Ajakan Bertindak (3 Detik)",
    colorHex: "0xd97706", // Amber
    toneFreq: 800,
  },
  {
    folder: CTAS_DIR,
    filename: "cta3.mp4",
    tag: "CTA 3",
    title: "Klaim Gratis Ongkir Seluruh Indo!",
    desc: "Ajakan Bertindak (3 Detik)",
    colorHex: "0xe11d48", // Rose
    toneFreq: 880,
  },
];

async function generateClip(spec: ClipSpec) {
  const outputPath = path.join(spec.folder, spec.filename);
  const fontPath = "C\\:/Windows/Fonts/arial.ttf";

  // Visual card:
  // 1. Tag box di atas (HOOK 1 / BODY 1 / CTA 1)
  // 2. Judul di tengah
  // 3. Deskripsi
  // 4. Timecode live
  const vf = [
    `drawtext=fontfile='${fontPath}':text='[ ${spec.tag} ]':fontsize=76:fontcolor=white:x=(w-text_w)/2:y=650:box=1:boxcolor=black@0.5:boxborderw=24`,
    `drawtext=fontfile='${fontPath}':text='${spec.title}':fontsize=50:fontcolor=white:x=(w-text_w)/2:y=850`,
    `drawtext=fontfile='${fontPath}':text='${spec.desc}':fontsize=36:fontcolor=white@0.8:x=(w-text_w)/2:y=960`,
    `drawtext=fontfile='${fontPath}':text='Durasi Segmen\\: %{pts\\:hms} / 00\\:00\\:03':fontsize=34:fontcolor=yellow:x=(w-text_w)/2:y=1100:box=1:boxcolor=black@0.4:boxborderw=12`,
  ].join(",");

  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${spec.colorHex}:s=1080x1920:d=3:r=30`,
    "-f", "lavfi", "-i", `sine=f=${spec.toneFreq}:r=48000:d=3`,
    "-vf", vf,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-profile:v", "high", "-level:v", "4.1",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    outputPath,
  ];

  await execFileAsync(FFMPEG_BIN, args, { windowsHide: true });
}

async function main() {
  console.log("=== Membuat 9 Video Trial (3 Hook, 3 Body, 3 CTA @ 3 Detik) ===");
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.mkdirSync(BODIES_DIR, { recursive: true });
  fs.mkdirSync(CTAS_DIR, { recursive: true });

  const t0 = performance.now();

  for (let i = 0; i < CLIPS.length; i++) {
    const clip = CLIPS[i]!;
    process.stdout.write(`Generating [${i + 1}/9] ${path.basename(clip.folder)}/${clip.filename}... `);
    await generateClip(clip);
    console.log("DONE ✅");
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`\n🎉 Selesai dalam ${elapsed} detik!`);
  console.log(`Folder target: ${TARGET_DIR}`);
}

main().catch((err) => {
  console.error("Gagal membuat trial clips:", err);
  process.exit(1);
});
