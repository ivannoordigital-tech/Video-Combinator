# Implementation Backlog — Video Combinator v2

**Basis:** `PRD_V2_VIDEO_COMBINATOR.md`
**Total estimasi:** ~95 jam (12–14 hari kerja solo)
**Aturan:** setiap task harus punya output yang bisa diverifikasi. Jangan mulai fase berikutnya sebelum gate fase sebelumnya lolos.

---

## Definition of Done (global)

Sebuah task dianggap selesai jika:
- `npm run lint` + `npm run typecheck` + `npm test` hijau.
- Perilaku bisa diverifikasi lewat CLI/API/UI, bukan hanya "kode sudah ditulis".
- Error path ditangani (bukan hanya happy path).
- Tidak ada `console.log` liar; pakai logger terstruktur.
- Dokumentasi singkat diperbarui bila mengubah kontrak.

---

## Fase 0 — Fondasi (6 jam)

| ID | Task | Jam | Dep | Output / Verifikasi |
|---|---|---|---|---|
| T0.1 | Scaffold repo terpisah: `package.json` (ESM, Node ≥24), TS, ESLint, Prettier, struktur folder §4 | 2 | — | `npm run build` & `npm run dev` jalan |
| T0.2 | Skema Zod: `product.json`, `assets.json`, `manifest.json`, `job.json` + tipe TS | 2 | T0.1 | Validasi contoh JSON lolos/gagal sesuai aturan |
| T0.3 | Fixture generator (`scripts/make-fixtures.ts`) untuk 16 fixture §9.1 | 2 | T0.1 | `npm run fixtures` menghasilkan folder `fixtures/` lengkap |
| T0.4 | Benchmark harness: 125 kombinasi sintetis, ukur render/ingest/plan | 1 | T0.3 | Laporan ms/video + RSS |
| T0.5 | ADR singkat (D1–D12) + catatan lisensi FFmpeg | 0.5 | — | `docs/adr.md` |

**Gate F0:** 16 fixture ada, benchmark tercatat, skema disepakati. Tidak ada kode produksi yang ditulis sebelum gate ini.

---

## Fase 1 — Core Engine (24 jam)

| ID | Task | Jam | Dep | Output / Verifikasi |
|---|---|---|---|---|
| T1.1 | `ffmpeg.ts`: resolve binary `bin/`, health check, parse versi | 2 | T0.1 | `npm run cli -- doctor` menampilkan versi |
| T1.2 | `probe.ts`: wrapper ffprobe + `specSignature()` | 2 | T1.1 | Unit test: signature sama untuk 3 klip identik, beda untuk 720p |
| T1.3 | `fingerprint.ts`: `size+mtime` cache → sha256; cache di `state/` | 2 | T1.1 | Hash 3× pada file sama = 1 pembacaan |
| T1.4 | `ingest.ts`: encode normalisasi (audio & tanpa audio), verifikasi, cache by `sha+specHash` | 4 | T1.2, T1.3 | 4 fixture rusak → 4 output valid (skenario Lampiran D) |
| T1.5 | `slug.ts` + `naming.ts`: slug stabil, hash8, batas panjang, reserved names | 2 | T0.2 | Unit test: unicode, `CON`, nama 250 char, tabrakan |
| T1.6 | `scan.ts`: enumerasi 3 folder, validasi magic bytes, deteksi file hilang/berubah | 2 | T1.3 | Copy-paste 3 file → muncul; rename → `ORPHAN` |
| T1.7 | `plan.ts`: cartesian, scope (`new`/`stale`/`all`/`subset`), orphan, disk preflight, ETA | 3 | T1.6 | 5×5×5 → 125; tambah 1 hook → 25 queue |
| T1.8 | `render.ts`: list file, spawn, timeout, cancel, PID tracking, rename retry | 3 | T1.7 | Kill saat item 5 → 0 proses yatim |
| T1.9 | `verify.ts`: cek stream/durasi/spec/rotasi/size | 2 | T1.2 | Output dipotong → FAILED |
| T1.10 | `manifest.ts`: atomic write, JSONL append, replay recovery, flush tiap 10 item | 3 | T1.9 | Matikan proses paksa → manifest konsisten |
| T1.11 | `report.ts`: CSV UTF-8 BOM, CRLF, delimiter, escape | 1 | T1.10 | Buka di Excel id-ID benar |
| T1.12 | CLI: `doctor`, `scan`, `plan`, `render`, `report` + unit/integration test | 2 | T1.1–T1.11 | `npm run cli -- render --product x --scope new` end-to-end |

**Gate F1:** 125 video dari fixture selesai ≤90 s, 0 output invalid, kill-resume lolos, CSV benar. Ini gate terpenting — jangan lanjut ke backend sebelum lolos.

---

## Fase 2 — Backend (24 jam)

| ID | Task | Jam | Dep | Output / Verifikasi |
|---|---|---|---|---|
| T2.1 | Express 5 + security middleware (Host/Origin, `X-App-Request`, CSP, body limit) | 2 | F1 | Request lintas-origin ditolak 403 |
| T2.2 | `products` endpoints + bootstrap direktori + validasi slug | 2 | T2.1 | Create/list/get/patch; traversal 400 |
| T2.3 | Upload streaming + validasi + dedup + enable/disable + rescan | 4 | T2.2 | 2 file nama sama isi beda tersimpan keduanya |
| T2.4 | `plan` endpoint + cache hasil scan | 2 | T2.3 | 2.000 kombinasi ≤2 s |
| T2.5 | Job manager: single-flight, worker pool, cancel, recovery, persistence | 5 | T2.4 | Generate 2× → 409; cancel → 0 ffmpeg |
| T2.6 | SSE: snapshot, replay `Last-Event-ID`, heartbeat, disable compression | 3 | T2.5 | Refresh saat render → progress benar |
| T2.7 | Media + thumbnail endpoint (Range, ETag, cache invalidation) | 2 | T2.3 | `<video>` seek berfungsi; thumbnail 270×480 |
| T2.8 | CSV download + open-output (anti-injection) | 1 | T2.5 | Path berisi `&` aman |
| T2.9 | Integration test suite (supertest) untuk seluruh endpoint + error codes | 3 | T2.1–T2.8 | 100 % endpoint punya test sukses + error |

**Gate F2:** API test hijau, concurrent generate 409, cancel bersih, SSE reconnect benar.

---

## Fase 3 — Dashboard (24 jam)

| ID | Task | Jam | Dep | Output / Verifikasi |
|---|---|---|---|---|
| T3.1 | Design tokens + layout 3 kolom + Tailwind build lokal (tanpa CDN) | 3 | T2.7 | Halaman render offline |
| T3.2 | Produk selector + buat produk + settings modal | 2 | T3.1 | Ganti produk memuat state benar |
| T3.3 | Panel aset: upload dropzone, thumbnail lazy, enable/disable, preview modal | 4 | T3.1 | Upload drag-drop → aset muncul |
| T3.4 | Status bar + plan panel + scope selector + preflight dialog | 2 | T3.3 | Angka cocok dengan API |
| T3.5 | Progress SSE + Stop + speed/ETA + reconnect | 4 | T3.4 | Stop menghentikan render <2 s |
| T3.6 | Error UX: terjemahan kode error, toast, empty state, disabled reasons | 2 | T3.5 | Semua `E_*` punya pesan manusiawi |
| T3.7 | Aksi cepat: buka output, unduh CSV, rescan, buka database | 1 | T3.5 | Semua berfungsi |
| T3.8 | Responsive 1280–1920 + keyboard focus + loading skeleton | 2 | T3.6 | UAT desktop lolos |

**Gate F3:** UAT dengan satu orang non-teknis: buat produk → upload 9 klip → generate 27 video → unduh CSV, tanpa instruksi terminal.

---

## Fase 4 — Hardening & Rilis (16 jam)

| ID | Task | Jam | Dep | Output / Verifikasi |
|---|---|---|---|---|
| T4.1 | `Buka_Dashboard.bat` + auto-open browser + port fallback | 2 | F3 | Double-click → dashboard terbuka |
| T4.2 | Bundling `bin/ffmpeg.exe` + `ffprobe.exe` + catatan lisensi | 1 | T4.1 | Jalan tanpa ffmpeg di PATH |
| T4.3 | Logging rotasi + endpoint `health` + unduh diagnostik | 2 | T2.8 | ZIP diagnostik valid |
| T4.4 | Eksekusi 16 fixture + 16 AC, catat hasil | 4 | F3 | Tabel hasil 16/16 |
| T4.5 | README instalasi & operasional (termasuk exclusion Defender, larangan OneDrive) | 2 | T4.4 | Orang lain bisa install dari nol |
| T4.6 | Clean-VM test (tanpa Node? dengan Node saja) + perbaikan temuan | 3 | T4.4 | Install sukses <10 menit |

**Gate F4:** 16/16 AC lolos, tidak ada bug P0/P1 terbuka, instalasi mesin bersih sukses.

---

## Urutan Eksekusi yang Disarankan

1. **Vertical slice dulu (F1):** satu produk, 3×1×1 klip, dari scan → ingest → plan → render → manifest → CSV. Jangan sentuh UI sebelum ini benar.
2. **UI tipis (F3 versi awal):** tampilkan plan + progress SSE tanpa styling penuh; ini memvalidasi kontrak API lebih cepat.
3. **Baru polish:** Tailwind, error UX, settings, UAT.

Alasan: 80 % risiko ada di engine (parameter video, verifikasi, resume), bukan di tampilan.

---

## Checklist Rilis

- [ ] `bin/ffmpeg.exe` + `bin/ffprobe.exe` ada dan versinya tercatat
- [ ] `npm ci && npm run build` sukses di mesin bersih
- [ ] `Buka_Dashboard.bat` membuka browser ke port yang benar
- [ ] 16 fixture & 16 AC lolos (lampirkan tabel hasil)
- [ ] Tidak ada proses ffmpeg yatim setelah cancel/kill
- [ ] `database/` tidak berubah kecuali file yang diupload
- [ ] CSV terbuka benar di Excel id-ID
- [ ] Log & diagnostik bisa diunduh
- [ ] README berisi troubleshooting: port, antivirus, OneDrive, path panjang
