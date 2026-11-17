# PRD v2 — Automated Multi-Product Video Combinator

**Status:** FINAL v2.0 — menggantikan PRD v1 sepenuhnya
**Tanggal:** 17 November 2026
**Dasar:** `AUDIT_PRD_VIDEO_COMBINATOR.md` (audit + uji laboratorium)
**Target platform:** Windows 10/11 64-bit, native, tanpa Docker

---

## 0. Ringkasan Perubahan dari v1

| Area | v1 | v2 | Alasan |
|---|---|---|---|
| Sumber render | Klip mentah langsung di-concat | **Ingest → normalisasi sekali → concat** | 6 mode kegagalan senyap terbukti di uji lab |
| Validasi hasil | File ada & > 0 KB | **Verifikasi ffprobe (durasi, stream, spec)** | Exit code FFmpeg 0 bukan bukti sukses |
| Fallback | Re-encode seluruh kombinasi | **Repair per klip di ingest + retry copy**; re-encode penuh = mode Quality opsional | Fallback v1 terukur 4,6 menit/125 video |
| Atomic write | `.tmp` lalu rename | **`.part` + `-f mp4` + verify + rename retry** | `.tmp` tanpa `-f mp4` gagal total |
| Delta check | Ukuran > 0 KB | **Status manifest + fingerprint aset** | File terpotong lolos cek ukuran |
| Aset berubah | Tidak ditangani | **Fingerprint + status `STALE`** | Output lama tidak boleh dianggap valid |
| Penamaan | `produk__hook__body__cta.mp4` | **`+ hash8`**, slug ASCII, batas panjang | Ambiguitas `__`, MAX_PATH, tabrakan nama |
| Job control | Tidak dispesifikasikan | **Single-flight, cancel, resume, recovery** | Klik ganda & ffmpeg yatim |
| CSV | "Siap Ads Manager" | **Log produksi**, UTF-8 BOM, CRLF, delimiter konfigurabel | Skema bukan template bulk Meta |
| Port | 3000 | **3210** (auto 3211–3219) | Bentrok Remotion Studio & dev server lain |
| FFmpeg | Asumsi ada di PATH | **Di-bundle di `bin/`** | Mesin non-teknis tidak punya PATH |
| Keamanan | Tidak dibahas | **127.0.0.1, Host/Origin check, whitelist path** | DNS rebinding & path traversal |
| Struktur | `database/` + `output/` | **+ `cache/` + `state/`**, `database/` benar-benar read-only | Upload & metadata tidak boleh mengotori aset mentah |
| Kriteria uji | "Uji end-to-end" | **14 acceptance criteria + 16 fixture** | Tidak terukur = tidak bisa diterima |

**Validasi pipeline v2 (sudah dijalankan):** 4 klip sumber rusak (1280×720@25 44,1 kHz mono; tanpa audio; metadata rotasi 90°; 1080×1920@60) → ingest → concat copy menghasilkan **20,02 s, 1080×1920@30, AAC 48 kHz stereo, nol decode error, resolusi konsisten di semua segmen**. Ingest 5 detik klip ≈ 1,0–1,3 detik.

---

## 1. Tujuan, Non-Goals, dan Keputusan

### 1.1 Tujuan
1. Menghasilkan semua kombinasi Hook × Body × CTA per produk secara massal, terisolasi per produk.
2. Menjaga kualitas: hasil copy lossless terhadap klip yang sudah dinormalisasi.
3. Incremental: hanya render kombinasi baru/berubah; bisa dilanjutkan setelah crash.
4. Cepat: 125 video ≤ 90 detik (mode Fast) di mesin referensi.
5. Bisa dipakai tim non-teknis lewat satu klik `.bat`.

### 1.2 Non-Goals v1 (eksplisit)
- Overlay teks, caption, logo, watermark, musik latar, transisi.
- Bulk upload Ads Manager (CSV hanya log produksi).
- Multi-user, LAN, cloud, mobile UI.
- Menghapus/mengubah file mentah dari UI (v1 hanya enable/disable aset).
- Skenario "video berbeda-beda per kombinasi" (mis. hook A hanya untuk body B).

### 1.3 Keputusan arsitektur (dikunci)

| ID | Keputusan | Rasional |
|---|---|---|
| D1 | Dua tahap: **Ingest** (sekali/klip) lalu **Render** (copy) | Menghilangkan seluruh kelas kegagalan parameter |
| D2 | Mode default **Fast** = copy dari hasil normalisasi. Mode **Quality** (re-encode) hanya stub, tidak diimplementasi v1 | Menjaga SLA & kualitas |
| D3 | Spesifikasi kanonik per produk: 1080×1920, 30 fps CFR, H.264 High@4.1, yuv420p, GOP 60, SAR 1:1, AAC-LC 48 kHz stereo 192 kbps, loudnorm −16 LUFS | Kompatibilitas Ads + konsistensi audio |
| D4 | `database/` **read-only mutlak**; upload masuk ke `database/` hanya sebagai penambahan file baru; metadata di `state/`, turunan di `cache/` | Memenuhi NFR keamanan data |
| D5 | Manifest = satu-satunya sumber kebenaran status output | Delta check tidak boleh berbasis file |
| D6 | Nama output deterministik + hash8 + slug ASCII ≤ 32 karakter | MAX_PATH & tabrakan nama |
| D7 | `ffmpeg.exe`/`ffprobe.exe` di-bundle di `bin/`, dipanggil via path absolut | Mesin non-teknis |
| D8 | Aplikasi di repo terpisah `D:\Jobs\video-combinator` (bukan di repo Remotion ini) | Konflik dependency & port |
| D9 | Stack: Node 24 ESM + TypeScript + Express 5 + Zod + vanilla TS frontend + Tailwind build lokal (tanpa CDN) | Offline, sederhana, tanpa DB |
| D10 | Server bind `127.0.0.1`, port 3210 dengan fallback otomatis | Aman & tidak bentrok |
| D11 | Worker render default 3 (1–6), worker ingest 4 | I/O bound; hindari thrash disk |
| D12 | Durasi CSV = hasil ukur output, `created_at` ISO 8601 dengan offset lokal | Akurasi laporan |

---

## 2. Arsitektur

```
                 ┌─────────────────────────────┐
 file upload ───▶│ INGEST                      │
 (multipart)     │  probe → validate → encode  │──▶ cache/<p>/ingest/*.mp4
                 │  → verify → fingerprint     │    state/<p>/assets.json
                 └─────────────────────────────┘
                              │
                 ┌────────────▼────────────────┐
                 │ SCAN + PLAN                 │
                 │  cartesian H×B×C            │──▶ {total, done, stale, queue}
                 │  manifest delta + stale     │
                 │  disk preflight             │
                 └────────────┬────────────────┘
                              │
                 ┌────────────▼────────────────┐
                 │ RENDER (worker pool)        │
                 │  list → ffmpeg -c copy      │──▶ output/<p>/.parts/*.part
                 │  → verify → rename          │    output/<p>/*.mp4
                 └────────────┬────────────────┘
                              │
                 ┌────────────▼────────────────┐
                 │ MANIFEST → CSV → SSE → UI   │
                 └─────────────────────────────┘
```

**Alur data satu video:**
`assets.json` → rencana → list file UTF-8 (tanpa BOM) → `ffmpeg -c copy` ke `.part` → `ffprobe` verifikasi → `fs.rename` → entri manifest + JSONL → event SSE.

**Alur ingest satu klip:**
`probe` → validasi → fingerprint (`size+mtime+sha256`) → cek cache (`sha256+spec_hash`) → encode normalisasi → verifikasi → catat `assets.json`.

---

## 3. Spesifikasi Kanonik

`state/<product>/product.json`:

```json
{
  "schemaVersion": 1,
  "slug": "produk-sepatu",
  "displayName": "Produk Sepatu",
  "createdAt": "2026-11-17T09:00:00+07:00",
  "video": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "fit": "pad",
    "codec": "h264",
    "profile": "high",
    "level": "4.1",
    "pixFmt": "yuv420p",
    "crf": 18,
    "preset": "veryfast",
    "gop": 60
  },
  "audio": {
    "codec": "aac",
    "sampleRate": 48000,
    "channels": 2,
    "bitrate": "192k",
    "loudnorm": true,
    "targetLufs": -16
  },
  "render": {
    "mode": "fast",
    "workers": 3,
    "faststart": true
  },
  "naming": {
    "includeHash": true,
    "maxSlugLength": 28
  },
  "limits": {
    "maxCombinations": 2000,
    "warnCombinations": 500,
    "maxAssetSizeMb": 1024,
    "minClipSeconds": 0.5,
    "maxClipSeconds": 120
  }
}
```

**Aturan:**
- `slug` produk: `^[a-z0-9][a-z0-9-]{1,31}$` (tanpa `_`, tanpa spasi, tanpa unicode).
- `video.fit`: `pad` (default, tanpa kehilangan konten) atau `crop` (mengisi frame).
- Perubahan `video`/`audio` mengubah `specHash` → semua aset & output ditandai `STALE`.
- Spesifikasi ini **wajib** dipakai ingest; render tidak boleh mengubah parameter.

---

## 4. Struktur Direktori

```
video-combinator/
├─ Buka_Dashboard.bat
├─ bin/
│  ├─ ffmpeg.exe
│  └─ ffprobe.exe
├─ database/                       # ASET MENTAH — read-only mutlak
│  └─ <product>/
│     ├─ hooks/
│     ├─ bodies/
│     └─ ctas/
├─ cache/                          # turunan, boleh dihapus kapan saja
│  └─ <product>/
│     ├─ ingest/<sha8>__<slug>.mp4
│     ├─ thumbs/<kind>/<slug>.jpg
│     └─ uploads/<uuid>.part
├─ state/                          # metadata aplikasi (satu-satunya tempat menulis status)
│  └─ <product>/
│     ├─ product.json
│     ├─ assets.json
│     ├─ job.json
│     └─ locks/
├─ output/
│  └─ <product>/
│     ├─ .parts/
│     ├─ manifest.json
│     ├─ manifest.jsonl
│     ├─ report_iklan.csv
│     └─ <product>__<hook>__<body>__<cta>__<hash8>.mp4
├─ logs/
│  └─ <product>/render-YYYYMMDD.log
├─ public/                         # dashboard (HTML/JS/CSS hasil build)
└─ src/                            # server + core engine (TypeScript)
```

**Invarian:**
- Tidak ada kode yang menulis/menghapus isi `database/` kecuali endpoint upload (penambahan file baru) dan pembuatan folder produk.
- `cache/` boleh dihapus kapan pun; sistem akan regenerate.
- `output/` hanya berisi file final + manifest + CSV; file sementara selalu di `.parts/`.

---

## 5. Model Data

### 5.1 Status output
`DONE` · `FAILED` · `STALE` · `ORPHAN` · `CANCELLED`
(Status antrean `QUEUED`/`RENDERING` hanya ada di job, bukan di manifest.)

### 5.2 Entri aset (`state/<p>/assets.json`)
```json
{
  "schemaVersion": 1,
  "specHash": "9f2c…",
  "assets": {
    "hook": {
      "hook-01.mp4": {
        "slug": "hook-01",
        "enabled": true,
        "sha256": "ab12…",
        "sizeBytes": 48213004,
        "mtimeMs": 1763350000000,
        "durationSeconds": 4.02,
        "origin": "scan",
        "status": "READY",
        "ingestedAt": "2026-11-17T09:04:11+07:00",
        "error": null
      }
    },
    "body": {},
    "cta": {}
  }
}
```
Aturan slug: dibuat sekali saat aset pertama terlihat, ASCII lowercase, `[a-z0-9-]`, maks 28 karakter, jika bentrok diberi suffix `-2`, `-3`. **Slug tidak pernah berubah** selama `assets.json` ada (stabil untuk nama output).

### 5.3 Entri output (`output/<p>/manifest.json`)
```json
{
  "schemaVersion": 1,
  "product": "produk-sepatu",
  "specHash": "9f2c…",
  "updatedAt": "2026-11-17T10:02:33+07:00",
  "tool": { "app": "1.0.0", "ffmpeg": "9.0-full_build" },
  "outputs": {
    "produk-sepatu__hook-01__body-02__cta-01__ab12cd34.mp4": {
      "key": "ab12cd34",
      "hook": "hook-01.mp4",
      "body": "body-02.mp4",
      "cta": "cta-01.mp4",
      "status": "DONE",
      "durationSeconds": 12.34,
      "sizeBytes": 13421772,
      "createdAt": "2026-11-17T10:02:30+07:00",
      "assetFingerprints": { "hook": "ab12…", "body": "cd34…", "cta": "ef56…" },
      "specHash": "9f2c…",
      "verified": true,
      "error": null
    }
  }
}
```

### 5.4 Job (`state/<p>/job.json`)
```json
{
  "jobId": "job_01J…",
  "status": "RUNNING",
  "scope": "new",
  "total": 25,
  "done": 3,
  "failed": 0,
  "skipped": 0,
  "current": "produk-sepatu__hook-01__…mp4",
  "startedAt": "2026-11-17T10:00:00+07:00",
  "etaSeconds": 9,
  "cancelled": false
}
```

### 5.5 Durabilitas
- `manifest.json` ditulis atomik (`.tmp` + rename) setiap 10 item dan di akhir job.
- `manifest.jsonl` append satu baris per item (`DONE`/`FAILED`) → dipakai untuk recovery.
- Saat startup: replay entri JSONL yang lebih baru dari `manifest.updatedAt`, lalu tulis snapshot.
- `job.json` ditulis atomik per item; job berstatus `RUNNING` saat startup → `INTERRUPTED`.

---

## 6. Functional Requirements

### FR-0 — Ingest & Normalisasi (baru, wajib)

**Input:** file di `database/<p>/{hooks,bodies,ctas}/` (hasil scan) atau upload baru.
**Output:** `cache/<p>/ingest/<sha8>__<slug>.mp4` + entri `assets.json`.

Langkah:
1. `ffprobe` → wajib punya 1 stream video yang bisa didekode; durasi dalam `[0.5, 120]` detik; file ≤ 1 GB.
2. Hitung `sha256` (di-cache berdasarkan `size+mtime`).
3. Jika cache `sha256 + specHash` ada dan valid → lewati encode.
4. Encode dengan parameter kanonik (Lampiran A), termasuk:
   - `scale` + `pad`/`crop` ke 1080×1920, `setsar=1`, `fps=30`, `format=yuv420p`
   - autorotate otomatis (display matrix diterapkan, output tanpa rotasi)
   - audio dipaksa AAC 48 kHz stereo + loudnorm (jika ada audio)
   - klip tanpa audio → `anullsrc` 48 kHz stereo, `-shortest`
5. Verifikasi hasil: resolusi, fps, pix_fmt, SAR, codec, 1 video + 1 audio, rotasi 0, durasi ≈ sumber (±0,15 s).
6. Gagal → status `ERROR` + kode error; klip tidak masuk kombinasi.

**Acceptance:**
- Klip 720p/25 fps/44,1 kHz mono/rotasi 90°/tanpa audio lolos ingest dan menghasilkan output identik spesifikasinya.
- Ingest ulang tanpa perubahan → 0 encode (cache hit).
- Perubahan `specHash` → semua aset di-ingest ulang.

---

### FR-1 — Manajemen Produk & Isolasi

- `POST /api/products` membuat `database/<slug>/{hooks,bodies,ctas}`, `cache/<slug>`, `state/<slug>`, `output/<slug>`, `logs/<slug>`.
- Semua operasi menerima `slug`, divalidasi regex, lalu `path.resolve` + cek prefix root (`realpath` untuk menolak junction/symlink keluar).
- Nama produk yang sudah ada → 409.
- Tidak ada operasi lintas produk: setiap fungsi engine menerima `productRoot` dan tidak pernah menerima path absolut dari user.

**Acceptance:**
- `slug = "../etc"`, `"..%2f"`, `"CON"`, `"a b"` ditolak 400.
- Produk A tidak bisa membaca/menulis folder produk B lewat API.

---

### FR-2 — Manajemen Aset

**Sumber aset:** upload dashboard dan copy-paste manual ke Explorer.

- **Scan:** enumerasi file `.mp4` (case-insensitive), abaikan file tersembunyi/`.tmp`/`.part`; urutkan natural.
- **Validasi:** ekstensi + magic bytes (`ftyp` pada offset 4) + ffprobe. File invalid → status `ERROR`, tetap terlihat di UI dengan pesan.
- **Upload:** streaming ke `cache/<p>/uploads/<uuid>.part` (bukan buffer memori), batas 1 GB/file, 50 file/request; validasi; pindahkan ke `database/<p>/<kind>/` dengan nama asli yang disanitasi (buang karakter ilegal Windows, reserved names, trailing dot/space). Nama bentrok: isi sama → 409 "sudah ada"; isi beda → suffix ` (2)`.
- **Enable/disable:** tombol UI mengubah `enabled` di `assets.json`, tidak menyentuh file. Aset nonaktif tidak masuk kombinasi; output terkait menjadi `ORPHAN`.
- **Rescan:** `POST /api/products/:slug/scan` — inkremental berdasarkan `size+mtime`.
- **Hapus:** tidak ada di v1 (sesuai NFR read-only).

**Acceptance:**
- Upload 2 file bernama sama dengan isi berbeda → keduanya tersimpan, tidak saling menimpa.
- File `.mp4` palsu/0 byte → ditolak, tidak masuk antrean.
- Copy-paste 3 file ke Explorer lalu klik Rescan → muncul tanpa restart.
- Menonaktifkan 1 hook → jumlah kombinasi turun, output lama ditandai `ORPHAN`.

---

### FR-3 — Planning, Kombinasi, Delta

**Perhitungan:**
`total = H_enabled_ready × B_enabled_ready × C_enabled_ready`

**Klasifikasi setiap kombinasi:**
| Kondisi | Status |
|---|---|
| Entri manifest `DONE`, fingerprint ketiga aset sama, file ada & ukuran > 0 | `SKIPPED` |
| File ada tapi tidak ada entri manifest | verifikasi sekali; valid → adopsi `DONE`; invalid → `QUEUED` |
| Entri `DONE` tapi fingerprint aset berubah | `STALE` |
| Entri `DONE` tapi file hilang | `QUEUED` |
| Belum ada entri | `QUEUED` |
| Aset nonaktif/hilang | `ORPHAN` |

**Scope render:**
- `new` (default): hanya kombinasi yang mengandung minimal satu aset yang belum pernah dipakai di output `DONE`.
- `stale`: hanya `STALE`.
- `all`: semua `QUEUED` + `STALE`.
- `subset`: kombinasi dari pilihan hook/body/CTA user.

**Pre-flight (wajib sebelum tombol aktif):**
- `estimasiMb = totalQueue × avgOutputMb × 1.15 + 500`
- `avgOutputMb` dari manifest (fallback 18 MB).
- Blokir jika `freeMb < estimasiMb` atau `total > maxCombinations`.
- Peringatan jika `total > warnCombinations`.

**Response plan:**
```json
{
  "counts": { "hooks": 5, "bodies": 5, "ctas": 5, "total": 125, "done": 100, "stale": 0, "orphan": 0, "queued": 25 },
  "scope": "new",
  "estimate": { "avgOutputMb": 18.2, "requiredMb": 1023, "freeMb": 118000, "etaSeconds": 12 },
  "blockers": [],
  "warnings": ["25 video baru akan dibuat (≈455 MB)"]
}
```

**ETA:** `ceil(queued × 0.4 detik / workers)` — diperbarui dengan rata-rata aktual selama job.

**Acceptance:**
- Menjalankan plan dua kali tanpa perubahan → `queued` sama, tidak ada duplikasi.
- Menambah 1 hook ke 5×5×5 → `queued` = 25 (bukan 125).
- File output dihapus manual → kembali `QUEUED`.
- File output di-truncate → tidak dianggap `DONE` (diverifikasi ulang).
- Free space kurang → tombol Generate nonaktif + pesan nominal.

---

### FR-4 — Render Engine

**Pre-flight per kombinasi (defense in depth):**
- Ketiga aset `READY`, `specHash` sama dengan produk.
- Signature ketiga file identik: `h264|high|4.1|1080x1920|yuv420p|30/1|1:1|aac|48000|2`.
- Jika tidak → `FAILED` dengan `E_SPEC_MISMATCH` (tidak pernah menulis output rusak).

**Eksekusi:**
1. Tulis `output/<p>/.parts/<key>.list` (UTF-8 **tanpa BOM**, path absolut dengan `/`, escape `'` → `'\''`).
2. Spawn:
   ```
   bin/ffmpeg.exe -y -nostdin -hide_banner -loglevel error
     -f concat -safe 0 -i <list>
     -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart
     -f mp4 <key>.part
   ```
3. Timeout 120 detik; simpan PID; dukung cancel (`taskkill /PID <pid> /T /F`).
4. Verifikasi (FR-5).
5. `fs.rename(.part → .mp4)` dengan retry 4× (100/300/900/2000 ms) untuk `EPERM`/`EBUSY`.
6. Update manifest + JSONL + SSE.

**Aturan tambahan:**
- Jika `E_RENAME_LOCKED` persisten: `.part` **disimpan**, status `FAILED`; job berikutnya mencoba rename ulang sebelum render ulang.
- Jika FFmpeg exit ≠ 0 **atau** verifikasi gagal → `.part` dihapus, `FAILED`, lanjut ke item berikutnya.
- Retry otomatis 1× untuk `E_RENAME_LOCKED`, `E_BUSY`, `E_TIMEOUT`.
- Worker pool 3 (konfigurabel 1–6). Tidak ada dua job untuk produk yang sama.

**Acceptance:**
- 125 video selesai ≤ 90 detik pada mesin referensi (termasuk verifikasi).
- Output yang gagal verifikasi tidak pernah muncul sebagai file `.mp4`.
- Kill proses saat video ke-60 → 65 video diproses ulang, 60 tetap `DONE`.
- Nama aset berisi apostrof/spasi/unicode tetap valid.
- Path output > 200 karakter tetap berhasil (slug dibatasi).

---

### FR-5 — Verifikasi Output

Setiap output diverifikasi dengan `ffprobe -of json`:

| Cek | Aturan |
|---|---|
| Jumlah stream | tepat 1 video + 1 audio |
| Codec | `h264` + `aac` |
| Resolusi | sama dengan spec |
| Frame rate | `avg_frame_rate` = spec (±0,01) |
| Audio | 48000 Hz, 2 channel |
| Rotasi | tidak ada side data rotasi |
| Durasi | `|aktual − (Σ durasi aset)| ≤ 0,25 s` |
| Ukuran | > 50 KB |
| Decode (opsional `verify.strict`) | `ffmpeg -v error -i out -f null -` tanpa error |

Gagal salah satu → `FAILED`, `.part` dihapus, error dicatat, SSE mengirim detail.

**Acceptance:** file yang dipotong 50 % tidak pernah dianggap `DONE`.

---

### FR-6 — Manifest & CSV

- Manifest ditulis atomik + JSONL append (lihat §5.5).
- CSV dibuat dari manifest (bukan dari nama file), ditulis atomik.
- Format: **UTF-8 dengan BOM**, CRLF.
- Delimiter: `,` default; opsi `;` untuk Excel locale Indonesia.
- Kolom:
  `filename, product, hook, body, cta, duration_seconds, created_at, status, size_mb, width, height, fps`
- `duration_seconds` = hasil ukur output (2 desimal, titik).
- `created_at` = ISO 8601 dengan offset (`2026-11-17T10:02:30+07:00`).
- CSV berisi semua output `DONE` (dan `STALE`/`ORPHAN` bila opsi `includeInactive` aktif).
- Endpoint mengirim `Content-Disposition: attachment`.

**Acceptance:** CSV dibuka di Excel id-ID tanpa mojibake, kolom tidak menumpuk, angka desimal benar.

---

### FR-7 — Job Control & SSE

- **Single-flight** per produk: `Map<slug, JobHandle>`; permintaan kedua → `409` + `{ currentJobId }`.
- **State machine:** `IDLE → RUNNING → (DONE | CANCELLED | FAILED)`.
- **Cancel:** hentikan scheduling, kill child aktif (tree kill), tunggu ≤5 s, tandai `CANCELLED`; item yang sudah `DONE` tetap.
- **Startup recovery:** `.parts/*.list` dihapus; `job.json` `RUNNING` → `INTERRUPTED`; `manifest` status `RENDERING` → `FAILED` (bila ada).
- **SSE** `GET /api/products/:slug/events`:
  - Event: `snapshot`, `item`, `progress`, `done`, `error`, `heartbeat`.
  - Setiap event punya `id` monotonik; server menyimpan 500 event terakhir untuk replay `Last-Event-ID`.
  - Saat connect: kirim `snapshot` penuh (job + counts) agar reconnect tidak reset ke 0.
  - Heartbeat 15 detik; `Cache-Control: no-cache, no-transform`; `X-Accel-Buffering: no`; kompresi dinonaktifkan.
- **Log:** satu baris per item + stderr FFmpeg ke `logs/<p>/render-YYYYMMDD.log`; rotasi 14 file/10 MB.

**Acceptance:**
- Dua tab menekan Generate → 1 job, tab kedua 409.
- Matikan jaringan/refresh saat render → progress kembali benar.
- Cancel → tidak ada proses `ffmpeg.exe` tersisa (cek Task Manager).
- Kill server saat render → restart menandai `INTERRUPTED`, tidak mengulang item `DONE`.

---

### FR-8 — API Contract

| Method | Path | Fungsi | Sukses | Error |
|---|---|---|---|---|
| GET | `/api/health` | versi app/ffmpeg, port, disk | 200 | — |
| GET | `/api/products` | daftar produk + counts | 200 | — |
| POST | `/api/products` | buat produk | 201 | 400, 409 |
| GET | `/api/products/:slug` | detail + spec + aset | 200 | 404 |
| PATCH | `/api/products/:slug` | ubah spec/settings | 200 | 400, 409 (job jalan) |
| POST | `/api/products/:slug/scan` | rescan inkremental | 200 | 404 |
| POST | `/api/products/:slug/assets` | upload (`kind`, `files[]`) | 201 | 400, 413, 415 |
| PATCH | `/api/products/:slug/assets/:kind/:file` | enable/disable | 200 | 404 |
| GET | `/api/products/:slug/plan?scope=` | ringkasan kombinasi | 200 | 409 (job jalan) |
| POST | `/api/products/:slug/render` | mulai job | 202 | 409, 422 (preflight) |
| POST | `/api/products/:slug/render/cancel` | batalkan | 202 | 404 |
| GET | `/api/products/:slug/job` | snapshot job | 200 | 404 |
| GET | `/api/products/:slug/events` | SSE | 200 | — |
| GET | `/api/products/:slug/report.csv` | unduh CSV | 200 | 404 |
| POST | `/api/products/:slug/open-output` | buka Explorer | 204 | 400 |
| GET | `/api/products/:slug/media/:kind/:file` | stream video + Range | 200/206 | 404 |
| GET | `/api/products/:slug/thumb/:kind/:file` | thumbnail JPEG | 200 | 404 |

**Aturan umum:** JSON error `{ error: { code, message, details? } }`; semua POST/PATCH memerlukan header `X-App-Request: 1`; tidak ada CORS.

---

### FR-9 — Dashboard

**Header:** dropdown produk, tombol "Produk Baru", ikon pengaturan.
**Panel aset (3 kolom):** dropzone upload, daftar aset dengan thumbnail 270×480 (lazy, `preload="none"`), nama, durasi, badge `BARU`/`SIAP`/`ERROR`/`NONAKTIF`, tombol enable/disable, klik untuk preview modal.
**Status bar:** Total · Selesai · Antrean · Stale · Orphan · estimasi disk/ETA.
**Kontrol:** scope selector (`Aset baru` | `Semua` | `Stale` | `Pilih…`), tombol **"Generate Video Baru"** (disabled saat job jalan / preflight gagal, dengan alasan terlihat).
**Progress:** progress bar, `x/y`, nama file aktif, kecepatan `video/menit`, ETA, tombol **Stop**.
**Aksi cepat:** Buka Folder Hasil, Unduh CSV, Buka Folder Database, Rescan.
**Error UX:** pesan bahasa Indonesia + tindakan, contoh:
- `Hook 3 (720×1280) tidak sesuai spesifikasi 1080×1920. Klik "Normalisasi ulang".`
- `FFmpeg tidak ditemukan. Jalankan ulang Buka_Dashboard.bat.`
- `Ruang disk kurang 1,2 GB. Kosongkan folder output lalu coba lagi.`
**Offline:** semua aset CSS/JS lokal; tidak ada CDN/font eksternal.

---

### FR-10 — Launcher

`Buka_Dashboard.bat`:
1. `cd /d "%~dp0"`, `chcp 65001`.
2. Cek `node --version` → jika tidak ada, tampilkan tautan unduh + `pause`.
3. Cek `bin\ffmpeg.exe` & `bin\ffprobe.exe`.
4. Jika `node_modules` tidak ada → `npm ci` dengan pesan jelas.
5. Jalankan `node dist/server.js`; server:
   - coba port 3210..3219, bind `127.0.0.1`;
   - buka browser default setelah listen (`cmd /c start "" http://127.0.0.1:<port>`);
   - tulis URL aktual ke console.
6. Saat server berhenti → `pause` agar error terbaca.

**Acceptance:** di mesin tanpa Node → pesan jelas, tidak crash; port 3210 dipakai aplikasi lain → otomatis pindah dan browser membuka port yang benar.

---

### FR-11 — Keamanan Lokal

- Bind hanya `127.0.0.1`.
- Validasi `Host` (`127.0.0.1:<port>` atau `localhost:<port>`) → selain itu 403 (anti DNS rebinding).
- Mutating request wajib `X-App-Request: 1` + `Origin`/`Sec-Fetch-Site` same-origin.
- Whitelist `slug`; semua path di-resolve dan diverifikasi prefix root (`realpath`).
- Upload: `Content-Type` multipart, batas ukuran, magic bytes, ffprobe; simpan di luar `public/`.
- Tidak ada static serving untuk `database/`, `output/`, `state/`, `cache/`; akses hanya lewat endpoint media dengan nama file dari state.
- CSP `default-src 'self'`; tanpa CORS `*`; tanpa telemetry.
- `explorer.exe` dipanggil dengan argumen array (tanpa shell), path hasil divalidasi.

---

### FR-12 — Observability & Recovery

- Log terstruktur (JSON line): `ts, level, product, jobId, item, code, durationMs, message`.
- `/api/health` melaporkan versi app, versi FFmpeg, port, free disk, jumlah job aktif.
- Tombol "Unduh Diagnostik" → ZIP berisi: `product.json`, `assets.json`, 200 baris log terakhir, ringkasan manifest, versi tool.
- Recovery otomatis sesuai FR-7.

---

## 7. Non-Functional Requirements (terukur)

| NFR | Target | Cara ukur |
|---|---|---|
| Render 125 video (20 s, mode Fast) | ≤ 90 detik | Benchmark harness, p95 |
| Throughput copy | ≥ 2 video/detik/worker | Log `durationMs` per item |
| Ingest | ≤ 0,25× realtime/klip | Benchmark 10 klip 20 s |
| Scan + plan 2.000 kombinasi | ≤ 2 detik | Timer di endpoint |
| Idempotensi | 0 render saat tidak ada perubahan | Test run 2× |
| Resume | kehilangan ≤ 1 item | Test kill -9 |
| RAM server | ≤ 180 MB idle, ≤ 250 MB saat job | `process.memoryUsage().rss` |
| Ukuran install | ≤ 250 MB (termasuk ffmpeg) | `du` |
| Kompatibilitas | Chrome/Edge/Firefox terbaru | UAT |
| Keandalan rename | 0 file final invalid | Verifikasi + audit manifest |

Mesin referensi: Windows 11, 12 thread, SSD, FFmpeg 9.0. Rekomendasi operasional: exclusion Defender untuk `output/` dan `cache/` (dijelaskan di README, bukan dilakukan otomatis).

---

## 8. Error Taxonomy

| Kode | Penyebab | Pesan pengguna | Aksi sistem |
|---|---|---|---|
| `E_FFMPEG_MISSING` | binary tidak ada | "FFmpeg tidak ditemukan." | Blokir semua render |
| `E_INPUT_CORRUPT` | tidak bisa didekode | "File X tidak bisa dibaca." | Aset `ERROR` |
| `E_INPUT_TOO_LONG` | > 120 s | "Durasi X melebihi batas." | Aset `ERROR` |
| `E_NO_VIDEO_STREAM` | audio saja | "File X bukan video." | Aset `ERROR` |
| `E_SPEC_MISMATCH` | parameter beda | "Klip X tidak sesuai spesifikasi." | Blokir kombinasi |
| `E_RENDER_FAILED` | ffmpeg exit ≠ 0 | "Render gagal: <ringkas stderr>." | Item `FAILED` |
| `E_VERIFY_FAILED` | output tidak valid | "Hasil verifikasi gagal." | Hapus `.part`, `FAILED` |
| `E_RENAME_LOCKED` | file terkunci | "File sedang dipakai aplikasi lain." | Retry 4× |
| `E_DISK_FULL` | ruang tidak cukup | "Ruang disk kurang X MB." | Blokir job |
| `E_TIMEOUT` | > 120 s | "Render melebihi batas waktu." | Kill, `FAILED` |
| `E_JOB_RUNNING` | job ganda | "Masih ada proses berjalan." | 409 |
| `E_PATH_INVALID` | traversal/reserved | "Nama tidak valid." | 400 |
| `E_LIMIT_EXCEEDED` | > 2.000 kombinasi | "Terlalu banyak kombinasi." | 422 |
| `E_UPLOAD_TOO_LARGE` | > 1 GB | "File terlalu besar." | 413 |

---

## 9. Test Plan & Acceptance Criteria

### 9.1 Fixture matrix (wajib dibuat di Fase 0)

| # | Fixture | Tujuan |
|---|---|---|
| 1 | 1080×1920@30 H.264 High + AAC 48k stereo ×3 | Baseline |
| 2 | 1280×720@25 | Resolusi & fps beda |
| 3 | 1920×1080 + rotasi 90° | Autorotate |
| 4 | Tanpa audio | Silent track |
| 5 | 44,1 kHz mono | Resample & pitch |
| 6 | 60 fps | CFR conversion |
| 7 | VFR (screen recording) | CFR conversion |
| 8 | Nama unicode, apostrof, spasi | Quoting |
| 9 | Nama 250 karakter | Batas path |
| 10 | `CON.mp4`, `aux .mp4` | Reserved name |
| 11 | 0 byte / bukan video / terpotong | Validasi |
| 12 | Dua file nama sama isi beda | Duplikat |
| 13 | File terkunci proses lain | Rename retry |
| 14 | 1.000 kombinasi | Stress & disk |
| 15 | Kill -9 saat render | Resume |
| 16 | CSV di Excel id-ID | Encoding |

### 9.2 Acceptance criteria (gate rilis)

| # | Kriteria | Verifikasi |
|---|---|---|
| AC-1 | 125 video ≤ 90 s, 0 output tanpa manifest | Benchmark |
| AC-2 | Kill saat video 60 → hanya 65 diproses, 0 `.part` tersisa | Test manual |
| AC-3 | Klip 720p → render diblokir dengan pesan spesifik | Fixture 2 |
| AC-4 | Klip tanpa audio → output 12 s dengan audio senyap sinkron | Fixture 4 |
| AC-5 | Klip rotasi 90° → output vertikal benar, tanpa side data rotasi | Fixture 3 |
| AC-6 | Output dipotong → masuk antrean, bukan `SKIPPED` | Fixture 11 |
| AC-7 | Dua tab Generate → 1 job, HTTP 409 | Test manual |
| AC-8 | SSE putus 10 s → progress benar setelah reconnect | DevTools |
| AC-9 | Nama 250 karakter → ditolak dengan pesan jelas | Fixture 9 |
| AC-10 | CSV di Excel id-ID → kolom & encoding benar | Fixture 16 |
| AC-11 | Path berisi `&`/spasi → Buka Folder aman | Test manual |
| AC-12 | Ganti isi hook (nama sama) → 25 output `STALE` | Fixture 12 |
| AC-13 | Klik Generate 3× → 1 job, 0 ffmpeg yatim | Test manual |
| AC-14 | Tanpa ffmpeg di PATH → launcher berpesan, tidak crash | Clean VM |
| AC-15 | Jalankan ulang tanpa perubahan → 0 render, mtime output tidak berubah | Test idempotensi |
| AC-16 | 1.000 kombinasi → preflight disk & batas bekerja | Fixture 14 |

---

## 10. Fase & Estimasi

Estimasi solo developer, 8 jam/hari. Detail task ada di `IMPLEMENTATION_BACKLOG.md`.

| Fase | Isi | Estimasi | Gate (Definition of Done) |
|---|---|---|---|
| **0. Fondasi** | Scaffold repo, schema Zod, fixture generator, benchmark, ADR | 1 hari | `npm run fixtures` menghasilkan 16 fixture; benchmark terdokumentasi |
| **1. Core engine** | Probe, fingerprint, ingest, scan, planner, renderer, verifier, manifest, CSV, CLI | 3 hari | 125 video dari fixture, kill-resume lolos, 0 output invalid |
| **2. Backend** | Express, upload, plan, job manager, SSE, security, media/thumb | 3 hari | Integration test API + concurrent generate + cancel |
| **3. Dashboard** | 3 panel aset, plan/stats, progress, error UX, settings | 3–4 hari | UAT skenario non-teknis |
| **4. Hardening** | Launcher, bundling ffmpeg, log/diagnostik, clean-VM, matriks uji | 2–3 hari | 16/16 fixture, 16/16 AC, install di mesin bersih |

**Total: 12–14 hari kerja.** Launcher dikerjakan awal di Fase 1 (versi minimal) agar pengujian end-to-end bisa dilakukan sepanjang proyek.

---

## 11. Risiko

| Risiko | Prob. | Dampak | Mitigasi |
|---|---|---|---|
| Ingest lambat pada klip panjang | Sedang | Sedang | Cache by hash; 4 worker; preset veryfast |
| Perubahan spec memicu re-ingest massal | Sedang | Sedang | Konfirmasi UI + estimasi waktu sebelum ubah |
| Antivirus mengunci rename | Sedang | Sedang | Retry + rekomendasi exclusion |
| Disk penuh saat render | Rendah | Tinggi | Preflight + cek ulang tiap 25 item |
| Nama aset tidak stabil (rename di Explorer) | Sedang | Sedang | Slug persisten di `assets.json`; aset lama → `ORPHAN` |
| ffmpeg versi berbeda antar mesin | Rendah | Sedang | Bundle + catat versi di manifest |
| OneDrive sinkron folder kerja | Sedang | Sedang | Dokumentasi: jangan taruh di folder OneDrive |
| Ekspektasi overlay teks | Sedang | Tinggi | Non-goal eksplisit + jalur Quality/Remotion terdokumentasi |

---

## 12. Di Luar Scope & Jalur Pengembangan

Jika nanti dibutuhkan **teks/overlay/musik/transisi**:
- **Mode Quality (v2.1):** render ulang per kombinasi dengan `filter_complex` (overlay, drawtext, music mix). Estimasi terukur: ~2,2 s per 12 s video → 125 video ≈ 5 menit. Antarmuka engine sudah menyediakan `render.mode` untuk ini.
- **Remotion (v3):** bila butuh animasi/compositing programatik. Biaya render jauh lebih tinggi dan memerlukan lisensi perusahaan; hanya jika kebutuhan kreatif menuntut.

---

## Lampiran A — Perintah FFmpeg

**A.1 Ingest (dengan audio):**
```bat
bin\ffmpeg.exe -y -hide_banner -nostdin -loglevel error ^
  -i "<input>" ^
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p" ^
  -map 0:v:0 -map 0:a:0 ^
  -c:v libx264 -preset veryfast -crf 18 -profile:v high -level:v 4.1 ^
  -x264-params "keyint=60:min-keyint=60:scenecut=0:force-cfr=1" ^
  -c:a aac -b:a 192k -ar 48000 -ac 2 ^
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" ^
  -movflags +faststart -video_track_timescale 15360 ^
  "<cache>\<sha8>__<slug>.mp4"
```

**A.2 Ingest (tanpa audio):**
```bat
bin\ffmpeg.exe -y -hide_banner -nostdin -loglevel error ^
  -i "<input>" -f lavfi -i "anullsrc=r=48000:cl=stereo" ^
  -vf "<filter seperti A.1>" ^
  -map 0:v:0 -map 1:a:0 ^
  -c:v libx264 -preset veryfast -crf 18 -profile:v high -level:v 4.1 ^
  -x264-params "keyint=60:min-keyint=60:scenecut=0:force-cfr=1" ^
  -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest ^
  -movflags +faststart -video_track_timescale 15360 ^
  "<cache>\<sha8>__<slug>.mp4"
```

**A.3 Render + verifikasi:**
```bat
bin\ffmpeg.exe -y -nostdin -hide_banner -loglevel error ^
  -f concat -safe 0 -i "<key>.list" ^
  -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart ^
  -f mp4 "<key>.part"

bin\ffprobe.exe -v error -of json ^
  -show_entries "format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels:stream_side_data=rotation" ^
  "<key>.part"
```

**A.4 Thumbnail:**
```bat
bin\ffmpeg.exe -y -v error -ss 0.5 -i "<clip>" -frames:v 1 -vf "scale=270:480" "<thumb>.jpg"
```

---

## Lampiran B — Algoritma Penamaan

```
slug(s):
  transliterate ke ASCII (NFKD, buang diakritik)
  lowercase
  ganti [^a-z0-9]+ -> "-"
  trim "-", potong ke 28 karakter
  jika kosong -> "x"
  jika bentrok dalam kind yang sama -> tambah "-2", "-3", ...

key = sha1(`${productSlug}|${hookFile}|${bodyFile}|${ctaFile}`).slice(0,8)

filename = `${productSlug}__${hookSlug}__${bodySlug}__${ctaSlug}__${key}.mp4`
```

Batas panjang: produk ≤32 + 3×28 + 8 + 4 separator + 4 ekstensi = **132 karakter**. Dengan root pendek, aman di bawah MAX_PATH.

---

## Lampiran C — Contoh CSV

```csv
filename,product,hook,body,cta,duration_seconds,created_at,status,size_mb,width,height,fps
produk-sepatu__hook-01__body-02__cta-01__ab12cd34.mp4,produk-sepatu,hook-01.mp4,body-02.mp4,cta-01.mp4,12.34,2026-11-17T10:02:30+07:00,DONE,12.80,1080,1920,30
```

(Disimpan UTF-8 **dengan BOM**, CRLF.)

---

## Lampiran D — Hasil Validasi Pipeline v2

Sumber uji (semua sengaja tidak kompatibel satu sama lain):

| Sumber | Masalah |
|---|---|
| 1280×720@25, AAC 44,1 kHz mono | Resolusi, fps, audio beda |
| 1080×1920@30, tanpa audio | Track audio hilang |
| 1920×1080@30, display matrix 90° | Rotasi |
| 1080×1920@60, AAC 48 kHz stereo | Frame rate beda |

Hasil setelah ingest + concat copy:

| Metrik | Hasil |
|---|---|
| Durasi | 20,02 s (target 20,0 s) |
| Stream | 1× H.264 1080×1920@30 + 1× AAC 48000 Hz stereo |
| Decode error | 0 |
| Resolusi per segmen (t=2,7,12,17) | 1080×1920 di semua titik |
| Side data rotasi | Hilang (sudah di-bake) |
| Waktu ingest per klip 5 s | 0,96–1,28 s |
| Ukuran output 20 s | 17,53 MB |

Kesimpulan: pipeline v2 menutup seluruh mode kegagalan yang ditemukan pada audit v1.
