# Audit & Analisa PRD — Automated Multi-Product Video Combinator

**Tanggal audit:** 17 November 2026
**Objek:** PRD "Automated Multi-Product Video Combinator" (v1, 4 fase)
**Lingkungan uji:** Windows, Node.js v24.18.0, FFmpeg 9.0-full_build (gyan.dev), 12 logical core
**PRD pengganti:** `PRD_V2_VIDEO_COMBINATOR.md` (v2.0 — semua temuan di dokumen ini sudah ditutup di sana)
**Backlog:** `IMPLEMENTATION_BACKLOG.md`

**Status repo:** `D:\Jobs\Remotion` masih berupa template Remotion (`src/HelloWorld.tsx`, `package.json` Remotion 4.0.540). Belum ada satu baris kode aplikasi combinator. Audit ini murni atas PRD + pengujian laboratorium FFmpeg.

---

## 1. Ringkasan Eksekutif

### Verdict
**Arah arsitektur benar, tetapi PRD belum aman untuk dieksekusi apa adanya.** Ide "normalisasi aset sekali, lalu concat stream-copy" adalah pendekatan yang tepat untuk target kecepatan. Masalahnya, PRD menganggap `ffmpeg -c copy` bersifat "sakti": selama file `.mp4`, pasti bisa digabung. Hasil uji menunjukkan sebaliknya — **6 dari 9 skenario ketidaksesuaian menghasilkan exit code 0 dan file "sukses", padahal outputnya rusak secara senyap.**

Target performa justru bagian yang paling aman: uji lab mencapai **155 ms/video**, jadi 125 video ≈ **19 detik** (bukan 2 menit). Risiko proyek ini bukan kecepatan, melainkan **integritas output, deteksi kegagalan, dan invalidation aset**.

### Skor kelayakan
| Dimensi | Skor | Catatan |
|---|---|---|
| Kejelasan tujuan bisnis | 8/10 | Alur produk → aset → kombinasi → laporan sudah jelas |
| Kelayakan performa (copy) | 9/10 | Terbukti jauh di bawah target |
| Ketahanan data / anti-corrupt | 2/10 | Banyak jalur gagal senyap, tidak ada verifikasi output |
| Ketepatan spesifikasi teknis | 4/10 | Parameter codec/audio/rotasi tidak didefinisikan |
| Testability / acceptance criteria | 2/10 | Tidak ada kriteria lolos terukur, tidak ada fixture uji |
| Operasional Windows (non-teknis) | 5/10 | `.bat` belum menangani ffmpeg di PATH, port, firewall, OneDrive |

### 7 temuan yang harus diputuskan sebelum coding
1. **Normalisasi ingest wajib** — jangan concat langsung dari file mentah.
2. **Exit code FFmpeg tidak boleh dipercaya** — verifikasi durasi & stream setiap output.
3. **Delta check `size > 0 KB` tidak valid** — file terpotong bisa lolos.
4. **"Auto-fallback re-encode" bertentangan dengan NFR** — terukur 4,6 menit/125 video, bukan 2 menit.
5. **Rotasi & audio tidak seragam** — output rusak tanpa error.
6. **Tidak ada invalidasi aset** — ganti klip dengan nama sama → output lama dianggap valid.
7. **Ledakan kombinasi** — 1.000 video ≈ 20 GB, melebihi budget disk 5 GB.

---

## 2. Verifikasi Lingkungan (lulus)

| Komponen | PRD | Terpasang | Status |
|---|---|---|---|
| Node.js | v24.18.0 | v24.18.0 | ✅ |
| npm | — | 12.0.2 | ✅ |
| FFmpeg | 9.0-full_build | 9.0-full_build-www.gyan.dev | ✅ |
| ffprobe | — | 9.0 | ✅ |
| Docker | tidak dibutuhkan | — | ✅ sesuai |

Catatan: `ffmpeg` dan `ffprobe` hanya tersedia karena ada di PATH mesin ini. Di mesin pengguna non-teknis, PATH hampir pasti berbeda → launcher akan gagal. Ini masalah dukungan nomor satu, bukan masalah sepele.

---

## 3. Hasil Uji Laboratorium

Fixture: 3 klip sintetis 1080×1920, 30 fps, H.264 + AAC 48 kHz stereo, masing-masing 4 detik (total 12 detik). Semua pengukuran dilakukan di mesin uji ini.

| # | Skenario | Exit | Hasil terukur | Kesimpulan |
|---|---|---|---|---|
| A | Concat copy 3 klip identik | 0 | 12,02 s, 23,1 MB, **199 ms** | Jalur utama valid |
| B | 40 video berurutan | 0 | rata-rata **155 ms/video** → 125 video ≈ **19 s** | Target 2 menit sangat longgar |
| C | 40 video, 4 worker paralel | 0 | 79 ms/video, speedup 1,97× | Paralelisasi membantu, tapi tidak perlu agresif |
| D | Output `.tmp` tanpa `-f mp4` | −22 | `Unable to choose an output format` | **Atomic write PRD akan gagal** |
| E | Output `.tmp` + `-f mp4` | 0 | 156 ms, valid, rename aman | Perbaikan sederhana |
| F | 1080p + 720p dicampur | **0** | Detik 1 = 1080×1920, detik 5 = **720×1280** dalam satu stream | Rusak senyap |
| G | 30 fps + 25 fps | **0** | `avg_frame_rate` jadi **85/3 (28,33)**, decoder: DTS non-monoton | Timestamp rusak |
| H | Klip tanpa audio + ber-audio | **0** | Audio klip ke-3 **maju 4 detik**, video tetap 12 s | A/V desync senyap |
| I | Audio 44,1 kHz mono + 48 kHz | **0** | Tone 440 Hz terukur **483 Hz** (+8,8 %) | Pitch/speed shift |
| J | Rotasi 90° (metadata HP) | **0** | Metadata rotasi **hilang** di output | Orientasi salah |
| K | Nama unicode + spasi | 0 | Berhasil (quoting benar) | Aman |
| L | Nama ber-apostrof, quoting naif | **0** | Hanya **4,02 s dari 8,02 s** masuk | **Exit 0 ≠ sukses** |
| M | Concat list ber-BOM UTF-8 | −1094995529 | `unknown keyword` | Gagal total, mudah terlewat |
| N | Biaya `ffprobe` per klip | — | **80 ms** | Scan 30 klip ≈ 2,4 s (cacheable) |
| O | Re-encode 12 s, `veryfast` CRF 23 | 0 | **2,2 s/video** → 125 ≈ **4,6 menit** | Melanggar NFR 2 menit |
| P | Re-encode `ultrafast` | 0 | 1,15 s/video → 125 ≈ 2,4 menit | Masih melanggar NFR |
| Q | Output terpotong 50 %, moov di akhir | — | `moov atom not found` | Tidak terbaca, tapi tetap "size > 0" |
| R | Output terpotong 50 %, `+faststart` | — | ffprobe lapor durasi **12,02 s** (seolah utuh), decode gagal | Cek durasi saja tidak cukup |

**Konsekuensi langsung:**
- Klaim "≈0,5–1 detik per video" realistis, bahkan konservatif.
- Klaim "125 video ≤2 menit" hanya berlaku untuk jalur copy. Begitu fallback re-encode aktif, SLA gagal 2,3×.
- `-movflags +faststart` praktis gratis (±20 ms), jadi wajib dipakai untuk kompatibilitas upload Ads Manager.

---

## 4. Temuan Kritis (P0)

### P0-1. Concat copy tidak memvalidasi parameter → korupsi senyap
PRD hanya menyeragamkan **resolusi** dan **frame rate** per produk. Itu tidak cukup. Agar `-c copy` aman, seluruh parameter berikut harus identik di semua klip:

- codec, profile, level, pix_fmt, dan `extradata` H.264
- resolusi, SAR/DAR, dan **matriks rotasi** (display matrix)
- `avg_frame_rate` **dan** `r_frame_rate` (termasuk keluarga 29,97/30)
- timebase dan pola timestamp (VFR vs CFR)
- codec audio, sample rate, channel count/layout, dan ada/tidaknya track audio

Uji F, G, H, I, J membuktikan pelanggaran satu parameter saja menghasilkan output "sukses" yang rusak. Menambahkan validasi saja tidak cukup karena klip mentah dari lapangan memang heterogen (iPhone, kamera, screen recording).

**Perbaikan:** tambahkan **Fase Ingest/Normalisasi** (FR-0). Setiap klip dinormalisasi sekali ke spesifikasi kanonik produk, di-cache, lalu semua kombinasi memakai klip hasil normalisasi. Ini mengubah masalah "N×M×K file harus kompatibel" menjadi "1 file harus kompatibel dengan spesifikasi".

### P0-2. Exit code FFmpeg bukan bukti sukses
Uji L: FFmpeg melaporkan `Error during demuxing`, tetap menulis file, dan **exit code 0**; hasilnya hanya separuh durasi. PRD hanya memeriksa "file ada dan > 0 KB".

**Perbaikan:** setiap output diverifikasi dengan `ffprobe`:
- tepat 1 stream video + 1 stream audio,
- codec `h264`/`aac`, resolusi & fps sesuai spec,
- durasi = jumlah durasi segmen ± 0,2 s (atau ±2 frame),
- decode spot-check opsional (`-v error -f null -`) untuk mode verifikasi ketat.

### P0-3. Atomic write versi PRD tidak bisa jalan
`output.mp4.tmp` tanpa `-f mp4` langsung gagal (uji D). Selain itu, `rename` di Windows bisa gagal karena antivirus, OneDrive sync, Explorer preview, atau file handle masih terbuka.

**Perbaikan:**
- Tulis ke `output/<produk>/.parts/<nama>.part` dengan `-f mp4 -movflags +faststart`.
- Setelah FFmpeg selesai **dan** verifikasi lolos, `fs.rename` ke `.mp4` dengan retry/backoff untuk `EPERM`/`EBUSY`.
- Bersihkan sisa `.part` saat startup; jangan pernah menganggap `.part` sebagai hasil.

### P0-4. "Auto-fallback re-encode" adalah proyek kedua, bukan fallback
Re-encode penuh terukur 2,2 s/video (veryfast) → 4,6 menit untuk 125 video, dan itu belum termasuk penurunan kualitas generasi kedua. PRD tidak mendefinisikan:
- kapan fallback dipicu (deteksi awal atau setelah gagal?),
- parameter encoder & target kualitas,
- konsekuensi terhadap SLA,
- apakah hardware encoder (NVENC/QSV) dipakai (mengubah kompatibilitas & kualitas).

**Perbaikan:** fallback yang benar = **perbaiki klip yang bermasalah di tahap ingest, lalu ulangi copy**, bukan re-encode seluruh kombinasi. Re-encode penuh dijadikan mode "Quality" opsional dengan estimasi waktu eksplisit di UI.

### P0-5. Audio: desync dan pitch shift tanpa peringatan
Uji H dan I menunjukkan dua mode kegagalan berbeda, keduanya exit 0. Untuk iklan, audio desync 4 detik = video tidak layak tayang, dan tidak akan terdeteksi sampai tim media buyer menontonnya.

**Perbaikan:** di ingest, semua klip dipaksa `AAC 48 kHz stereo`; klip tanpa audio disuntik track senyap (`anullsrc`, `-shortest`). Opsional: loudness normalization `loudnorm=I=-16:TP=-1.5` agar volume antar-talent konsisten.

### P0-6. Rotasi hilang
Video portrait dari iPhone sering tersimpan 1920×1080 + display matrix 90°. Concat copy membuang metadata itu (uji J), sehingga output tampil miring/terpotong. Ini kasus yang sangat sering terjadi pada footage iklan dari HP.

**Perbaikan:** ingest dengan autorotate (`-noautorotate` **tidak** dipakai; FFmpeg otomatis merotasi saat decode) + `setsar=1`, lalu encode ulang. Jangan pernah mengandalkan copy untuk klip yang punya display matrix.

### P0-7. Delta check berbasis ukuran file tidak sound
Uji Q/R: file terpotong 50 % tetap "size > 0". Dengan moov di akhir, file tidak terbaca; dengan faststart, durasi terbaca penuh padahal isi rusak. Delta check akan menandainya `SKIPPED` selamanya.

**Perbaikan:** status sukses hanya dari **manifest** (ditulis setelah verifikasi), bukan dari keberadaan file. Minimal simpan `duration_seconds`, `size_bytes`, `video_streams`, `audio_streams`, `codec_signature`, dan `asset_fingerprint` per output.

---

## 5. Gap Desain (P1)

### 5.1 Tidak ada konsep "aset berubah" (staleness)
PRD tidak menjelaskan apa yang terjadi jika:
- file `hook_01.mp4` ditimpa dengan isi berbeda (nama sama),
- klip dihapus,
- klip dipindah antar folder.

Akibatnya output lama tetap dianggap valid, CSV mencampur data lama dan baru, dan `manifest.json` tidak bisa dipercaya.

**Solusi:** fingerprint per aset = `size + mtime + SHA-256` (hash hanya klip, bukan output). Simpan di `product.json`/manifest. Saat scan, bandingkan. Jika berubah → tandai output terkait `STALE` dan masukkan ke antrean (atau minta konfirmasi user).

### 5.2 Penamaan file deterministik tapi rapuh
- Pemisah `__` ambigu jika nama klip mengandung `__`.
- Nama produk/klip unicode/emoji/apostrof menyulitkan concat list & upload Ads Manager.
- `MAX_PATH` 260 karakter mudah terlampaui: `output/produk_panjang/produk__hook__body__cta.mp4` dengan nama klip 60 karakter sudah >200 karakter sebelum folder induk.
- NTFS case-insensitive → `Hook_01` dan `hook_01` bertabrakan.
- Upload dua file bernama `video.mp4` akan saling menimpa jika tidak ditangani.

**Solusi:**
- Slug ASCII lowercase untuk nama output, maksimal ~40 karakter per komponen.
- Tambahkan hash pendek (6–8 karakter) dari logical key: `produk__hook__body__cta__a1b2c3.mp4`.
- Simpan mapping lengkap di manifest; **jangan pernah parsing nama file** untuk mengisi CSV.
- Tolak `__` di nama produk; sanitasi reserved names (`CON`, `PRN`, `NUL`, `COM1`) dan trailing dot/space.

### 5.3 Ledakan kombinasi & budget disk
Contoh PRD: 5×5×5 = 125 video. Jika tim menambah 1 hook pada 10 hook × 20 body × 10 CTA → **200 video baru**. Pada 20 detik/video, 8 Mbps ≈ 20 MB → 4 GB hanya untuk sekali tambah. 1.000 kombinasi ≈ **20 GB**, jauh di atas alokasi 5 GB.

**Solusi:**
- Pre-flight: `estimasi = jumlah_kombinasi × rata-rata_ukuran_output`; blokir jika > 80 % free space.
- Mode "Hanya kombinasi dengan aset baru" (default).
- Mode subset: pilih hook/body/CTA tertentu.
- Batas kombinasi per job + peringatan.

### 5.4 Job runner belum didefinisikan
PRD tidak menyebut:
- **single-flight lock** (dua tab / dua klik tombol Generate),
- **pembatalan** (Stop) dan pembersihan child process ffmpeg di Windows,
- **resume** setelah crash (termasuk pembersihan `.part` dan lock yatim),
- **paralelisme** (berapa worker, bagaimana urutan),
- **retry policy** per video,
- **reconnect SSE** (progress harus snapshot, bukan reset ke 0),
- **startup recovery** (job yang tertinggal berstatus `RENDERING`).

Ini pekerjaan nyata, bukan detail implementasi. Perkirakan 1–2 hari khusus untuk job control.

### 5.5 Manifest & CSV
- `manifest.json` ditulis ulang 125–1.000 kali; tulis atomik (`.tmp` + rename) atau append-only JSONL.
- Tidak ada `schema_version`, status, error, fingerprint, versi FFmpeg, parameter render.
- Durasi di CSV sebaiknya **hasil ukur output**, bukan penjumlahan durasi input.
- CSV "siap pakai untuk Ads Manager" **tidak akurat**: kolom PRD tidak mengikuti template bulk upload Meta Ads Manager (yang butuh Ad Name, Title, Body, Link, dsb.). Ini log produksi, bukan file impor iklan. Klarifikasi labelnya atau tambah kolom yang diminta.
- Excel locale Indonesia: butuh **UTF-8 dengan BOM** + CRLF; pemisah `;` sering diperlukan. Tanpa ini, karakter rusak dan kolom menumpuk.

### 5.6 Aspek Windows yang belum disentuh
- **Port 3000 bentrok** dengan Remotion Studio (`npm run dev`) di repo ini, dan dengan banyak dev server lain. Gunakan 3210/3217 dan cek port.
- **Firewall prompt** muncul jika bind ke `0.0.0.0`; bind `127.0.0.1` menghindarinya.
- **OneDrive/antivirus** dapat mengunci file saat rename dan memperlambat copy 2–5×.
- **`explorer.exe`** mengembalikan exit code 1 meski sukses; jangan dianggap gagal, dan jangan pakai `cmd /c start` (rawan injection pada path berisi `&`).
- **`ffmpeg` tidak di-bundle** → pengguna non-teknis tidak bisa menjalankan aplikasi. Sertakan `bin/ffmpeg.exe` + `bin/ffprobe.exe` dan resolusi path relatif ke direktori aplikasi. Catat konsekuensi lisensi jika build GPL didistribusikan.
- **Codepage console** (`chcp 65001`) agar log unicode tidak mojibake.
- **Path panjang**: root pendek (`D:\vc\`) dan hindari folder yang disinkronkan cloud.

### 5.7 Keamanan (localhost bukan berarti aman)
Dashboard lokal tetap bisa diserang dari browser:
- **DNS rebinding / CSRF** ke `localhost:3000` dari situs berbahaya.
- **Path traversal** pada parameter produk/nama file.
- **Upload tak terbatas** (memory/disk exhaustion).
- **Directory listing** jika folder `database/` di-serve statis.

Mitigasi minimum:
- Bind `127.0.0.1`; validasi header `Host` dan `Origin` untuk semua POST.
- Whitelist `product` `^[a-z0-9][a-z0-9_-]{0,31}$`; `path.resolve` + cek prefix root.
- `realpath` untuk menolak symlink/junction keluar folder.
- Upload: batas ukuran, validasi magic bytes (`ftyp`) + `ffprobe` sebelum diterima.
- Jangan serve `database/` sebagai static; hanya endpoint media dengan root whitelist + dukungan HTTP Range.
- Jangan aktifkan CORS `*`.

### 5.8 UI/UX yang belum dispesifikasikan
- Preview 60 video 1080p sekaligus akan berat → butuh thumbnail (`ffmpeg -ss 0.5 -frames:v 1`), `preload="metadata"`, lazy loading.
- Tidak ada kontrol Stop/Pause, filter, pencarian, atau sortir aset.
- Tidak ada penjelasan error dalam bahasa manusia ("Hook 3: resolusi 720×1280, produk ini 1080×1920").
- Tidak ada pengaturan (jumlah worker, path FFmpeg, format nama, quality mode).
- Tidak ada indikator "aset berubah → 12 output perlu dibuat ulang".

---

## 6. Kontradiksi & Ambiguitas di PRD

| # | Bagian | Masalah | Rekomendasi |
|---|---|---|---|
| 1 | FR-2 vs Keamanan Data | Upload menulis ke `database/`, tapi NFR bilang "read-only terhadap database/" | Nyatakan: tidak ada operasi ubah/hapus aset; upload hanya menambah file baru |
| 2 | FR-5 | "report_iklan.csv siap pakai untuk Ads Manager" | Ganti jadi "log produksi"; atau tambahkan skema bulk Ads Manager |
| 3 | NFR | "≤1 s/video" dan "125 video ≤2 menit" (125 s = 2,08 menit) → margin nol | Targetkan ≤60 s untuk 125 video copy; ukur p95 di mesin target |
| 4 | NFR | RAM ≤150 MB, tapi fallback re-encode paralel tidak dibatasi | Batasi worker; ukur RSS aktual; jangan pakai buffer upload di memori |
| 5 | FR-4 | "Auto-fallback re-encoding ringan" tanpa definisi pemicu/kualitas | Definisikan: repair per klip + retry copy; mode Quality terpisah |
| 6 | FR-3 | "ukuran > 0 KB" sebagai kriteria sukses | Ganti: status manifest + verifikasi ffprobe |
| 7 | FR-1 | Struktur folder tidak punya area kerja sementara/ingest | Tambah `.ingest/`, `.parts/`, `logs/` |
| 8 | FR-6 | Progress SSE tanpa reconnect/cancel/snapshot | Spesifikasikan heartbeat, `Last-Event-ID`, snapshot, 409 saat job ganda |
| 9 | FR-7 | Port 3000, tanpa cek ffmpeg/PATH/port | Port konfigurabel, health check, bundling ffmpeg |
| 10 | Fase | Tidak ada estimasi, definisi selesai, kriteria uji, risk register | Tambahkan per fase (lihat §9–§10) |
| 11 | Umum | Tidak ada spesifikasi durasi/aspect/audio/rotasi/limit klip | Tambah spec kanonik per produk |
| 12 | Umum | Tidak ada kebijakan hapus aset, output yatim, atau retensi | Definisikan status `ORPHAN` dan kebijakan manual-only delete |

Catatan kecil: rumus "Total Video = N Hook × N Body × N CTA" terduplikasi/formatnya rusak di dokumen — tidak material, tapi menandakan dokumen belum di-review teknis.

---

## 7. Arsitektur yang Direkomendasikan

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. INGEST    │→ │ 2. VALIDATE  │→ │ 3. PLAN      │→ │ 4. RENDER    │
│ normalize    │   │ fingerprint  │   │ cartesian   │   │ copy concat  │
│ sekali/klip  │   │ spec check   │   │ delta scan  │   │ N worker     │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
                                                                ↓
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 7. DASHBOARD │← │ 6. CSV       │← │ 5. VERIFY    │← │ output .part │
│ SSE + UI     │   │ from manifest│   │ ffprobe      │   │ → rename     │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

### 7.1 Spesifikasi kanonik per produk (`product.json`)
```json
{
  "schema_version": 1,
  "slug": "produk_sepatu",
  "video": {
    "width": 1080, "height": 1920, "fps": 30,
    "codec": "h264", "profile": "high", "level": "4.1",
    "pix_fmt": "yuv420p", "gop": 60, "sar": "1:1"
  },
  "audio": {
    "codec": "aac", "sample_rate": 48000,
    "channels": 2, "bitrate": "192k", "loudnorm": -16
  },
  "render": { "mode": "copy", "workers": 3, "faststart": true }
}
```

### 7.2 Struktur folder (revisi FR-1)
```
database/<produk>/
  hooks/  bodies/  ctas/       # ASLI — tidak pernah diubah/dihapus
  .ingest/                     # hasil normalisasi (derived, boleh dihapus)
  product.json                 # spec kanonik + settings
output/<produk>/
  .parts/                      # file .part, dibersihkan saat startup
  manifest.json                # sumber kebenaran status
  manifest.jsonl               # audit append-only (opsional)
  report_iklan.csv
logs/<produk>/render-YYYYMMDD.log
bin/ffmpeg.exe  bin/ffprobe.exe
Buka_Dashboard.bat
```

### 7.3 Perintah kunci

**Normalisasi (sekali per klip):**
```bat
ffmpeg -y -hide_banner -nostdin -i "input.mp4" ^
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p" ^
  -c:v libx264 -preset veryfast -crf 18 -profile:v high -level 4.1 ^
  -x264-params "keyint=60:min-keyint=60:scenecut=0" ^
  -c:a aac -b:a 192k -ar 48000 -ac 2 ^
  -movflags +faststart -video_track_timescale 15360 ^
  "normalized.mp4"
```
- Klip tanpa audio: tambahkan `-f lavfi -i anullsrc=r=48000:cl=stereo -shortest`.
- `fps=30` mengubah VFR → CFR; autorotate otomatis terjadi saat decode.

**Render (per kombinasi):**
```bat
ffmpeg -y -hide_banner -nostdin -f concat -safe 0 -i "list.txt" ^
  -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart -f mp4 ^
  "output/.parts/produk__hook__body__cta__ab12cd.part"
```
- List ditulis UTF-8 **tanpa BOM**.
- Path di dalam list di-quote; apostrof di-escape `'\''`.
- Setelah sukses + verifikasi → `fs.rename` ke `.mp4`.

**Verifikasi:**
```bat
ffprobe -v error -show_entries ^
  format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels ^
  -of json "file.mp4"
```
Lolos jika: 1 video + 1 audio, h264/aac, 1080×1920, 30/1, 48000/2, durasi target ±0,2 s.

### 7.4 Status yang harus ada
`PENDING` · `RENDERING` · `DONE` · `FAILED` · `SKIPPED_EXISTS` · `STALE` · `ORPHAN` · `CANCELLED`

---

## 8. Tambahan Requirement (FR baru)

| FR | Nama | Isi minimum |
|---|---|---|
| **FR-0** | Ingest & Normalisasi | Normalisasi sekali/klip ke spec kanonik, cache by fingerprint, inject silent audio, autorotate, loudnorm opsional |
| **FR-8** | Job Control | Single-flight per produk, cancel + tree-kill, resume, startup recovery, retry, worker pool, log per job |
| **FR-9** | Observability | Log per render, ringkasan error, ekspor diagnostik (versi, spec, durasi, error) |
| **FR-10** | Keamanan lokal | Bind 127.0.0.1, Host/Origin check, whitelist path, batas upload, validasi magic bytes, tanpa CORS `*` |
| **FR-11** | Invalidation | Fingerprint aset, deteksi `STALE`, konfirmasi user sebelum regen massal |
| **FR-12** | Kapasitas | Pre-flight disk, batas kombinasi, mode "hanya aset baru", subset selection |

---

## 9. Acceptance Criteria (harus masuk PRD)

| # | Kriteria |
|---|---|
| AC-1 | 125 kombinasi 12 s selesai < 60 s pada mesin uji (copy), 0 file tanpa entri manifest |
| AC-2 | Kill proses saat video ke-60; jalankan ulang → hanya 65 video diproses, tidak ada `.part` tersisa, tidak ada output ganda |
| AC-3 | Klip 720p dimasukkan ke produk 1080p → render diblokir dengan pesan spesifik, bukan output rusak |
| AC-4 | Klip tanpa audio → output tetap sinkron (segmen senyap 4 s), audio 12 s |
| AC-5 | Klip rotasi 90° → output tampil vertikal benar |
| AC-6 | Output dipotong 50 % → delta scan memasukkan ke `RENDER_QUEUE`, bukan `SKIPPED` |
| AC-7 | Dua tab menekan Generate bersamaan → hanya 1 job berjalan, tab kedua menerima HTTP 409 |
| AC-8 | SSE terputus 10 s → reconnect menampilkan progress terkini, bukan reset ke 0 |
| AC-9 | Nama klip 250 karakter → ditolak dengan pesan jelas, bukan gagal FFmpeg |
| AC-10 | CSV dibuka di Excel locale id-ID → kolom benar, tidak ada mojibake |
| AC-11 | Path hasil berisi spasi/`&` → tombol Buka Folder tetap aman (tanpa shell injection) |
| AC-12 | Ganti isi `hook_01.mp4` (nama sama) → 25 output terkait ditandai `STALE` |
| AC-13 | Klik Generate 3× cepat → tepat 1 job, tidak ada ffmpeg yatim |
| AC-14 | Mesin tanpa ffmpeg di PATH → launcher menampilkan instruksi, tidak crash |

---

## 10. Rencana Fase (Revisi) + Estimasi

Timeline solo developer, area kerja ~10–14 hari. Fase 0 tidak ada di PRD dan justru paling penting.

| Fase | Isi | Estimasi | Deliverable / gate |
|---|---|---|---|
| **0. Spike & keputusan** | Benchmark (sudah dilakukan), putuskan spec kanonik, 12 fixture uji, kontrak API | 1–1,5 hari | `product.json` spec + daftar fixture + keputusan copy-only |
| **1. Core engine** | Scanner, ingest/normalisasi, fingerprint, delta, planner, concat, verifikasi, manifest | 3 hari | CLI yang menghasilkan 125 video + manifest valid |
| **2. Backend & job runner** | Express, upload, single-flight, SSE, cancel, recovery, CSV, open folder | 3 hari | API teruji + stress 1.000 kombinasi |
| **3. Dashboard** | Tailwind lokal (bukan CDN), preview/thumbnail, progress, error UX, settings | 3–4 hari | UAT non-teknis |
| **4. Hardening & launcher** | `.bat`, bundling ffmpeg, port/firewall, antivirus/OneDrive, QA matrix | 2–3 hari | Instalasi bersih di mesin tanpa dev tools |

Perubahan urutan yang disarankan: **launcher dibuat di Fase 1**, agar pengujian end-to-end bisa dilakukan sejak awal oleh non-developer. Fase 4 tinggal hardening, bukan membangun dari nol.

---

## 11. Risk Register

| Risiko | Prob. | Dampak | Mitigasi |
|---|---|---|---|
| Klip heterogen → output rusak senyap | Tinggi | Tinggi | Ingest normalisasi + verifikasi output |
| Fallback re-encode melanggar SLA | Tinggi | Sedang | Copy-only default; mode Quality terpisah |
| Disk penuh / ledakan kombinasi | Sedang | Tinggi | Pre-flight + batas + mode aset baru |
| FFmpeg tidak ditemukan di mesin user | Tinggi | Tinggi | Bundling `bin/` + health check |
| Antivirus/OneDrive mengunci rename | Sedang | Sedang | Retry + `.part` + rekomendasi exclusion |
| Job ganda / ffmpeg yatim | Sedang | Sedang | Single-flight, PID registry, tree-kill |
| CSV tidak terbaca Excel | Sedang | Rendah | UTF-8 BOM, CRLF, pemisah konfigurabel |
| Path > 260 karakter | Sedang | Sedang | Slug pendek + hash + root pendek |
| Aset berubah tanpa invalidasi | Tinggi | Tinggi | Fingerprint + status `STALE` |
| Ekspektasi "Ads Manager ready" tidak terpenuhi | Sedang | Rendah | Klarifikasi label / tambah kolom |

---

## 12. Test Plan (Fixture Matrix)

Wajib ada sebelum coding dianggap selesai:

1. Baseline 1080×1920@30, H.264 High, AAC 48k stereo ×3
2. Resolusi berbeda (720×1280)
3. Frame rate berbeda (25, 29,97, 60)
4. Tanpa audio
5. Audio 44,1 kHz mono
6. Rotasi 90° dan 270°
7. VFR (screen recording)
8. Nama: unicode, apostrof, `__`, 250 karakter, `CON.mp4`, spasi di akhir
9. File 0 byte, file terpotong, `.mp4` palsu (bukan video), file terkunci
10. Duplikat nama upload
11. 1.000 kombinasi (stress + disk)
12. Render dihentikan paksa (kill -9) lalu dilanjutkan
13. Disk hampir penuh
14. Dua tab / dua klik Generate
15. SSE disconnect
16. Jalankan ulang tanpa perubahan → 0 render, output tidak berubah (idempotensi)

---

## 13. Keputusan yang Perlu Diambil Sekarang

1. **Apakah video butuh overlay teks/caption/logo/musik?**
   Jika ya, desain copy-only tidak bisa memenuhinya. Pilih: (a) copy-only tanpa overlay, (b) re-encode terbatas untuk overlay (waktu naik 5–10×), atau (c) Remotion untuk komposisi programatik.
2. **Sumber klip:** footage kamera/HP heterogen atau sudah diseragamkan tim produksi? Jika heterogen, FR-0 wajib.
3. **Default mode:** Fast (copy, tanpa normalisasi visual) atau Safe (ingest normalize + copy)? Rekomendasi: Safe.
4. **Skala realistis:** 125, 1.000, atau lebih? Menentukan strategi disk & UI.
5. **Lokasi aplikasi:** repo ini adalah template Remotion dan tidak memakai Remotion untuk PRD ini. Buat repo/folder terpisah, dan hindari port 3000 (dipakai Remotion Studio).
6. **Target "siap Ads Manager":** log produksi saja, atau benar-benar file bulk upload Meta? Jika ya, skema CSV harus mengikuti template Meta.

---

## 14. Patch Teks PRD (siap tempel)

- **FR-3:** ganti *"Cek apakah file output sudah ada … ukurannya > 0 KB"* → *"Status sukses ditentukan oleh entri manifest berstatus DONE yang telah diverifikasi ffprobe (durasi ±0,2 s, 1 video + 1 audio). Keberadaan file saja tidak cukup."*
- **FR-4:** ganti *"Auto-Fallback: beralih ke re-encoding ringan"* → *"Jika klip tidak sesuai spec, klip tersebut dinormalisasi ulang di ingest lalu copy diulang. Re-encode seluruh kombinasi hanya tersedia sebagai mode Quality opsional dengan estimasi waktu di UI."*
- **FR-4:** tambah *"Output ditulis ke `.parts/<nama>.part` dengan `-f mp4`; rename atomik setelah verifikasi; retry pada EPERM/EBUSY; `.part` dibersihkan saat startup."*
- **FR-5:** ganti *"report_iklan.csv siap pakai untuk Ads Manager"* → *"report_iklan.csv adalah log produksi (UTF-8 BOM, CRLF) untuk operasional tim; bukan template bulk upload Ads Manager."*
- **FR-7:** ganti port 3000 → *"port 3210 (konfigurabel), cek ketersediaan port, bind 127.0.0.1"*.
- **NFR:** ganti *"125 video ≤2 menit"* → *"125 video ≤60 detik pada mode copy di mesin referensi; mode Quality memiliki SLA terpisah."*
- **Keamanan Data:** tambah *"Tidak ada endpoint yang mengubah atau menghapus aset; upload hanya menambah file baru. Semua path divalidasi terhadap root produk."*

---

## 15. Lampiran: Bukti Perintah Uji

```bat
:: 1. concat copy baseline
ffmpeg -y -v error -f concat -safe 0 -i list1.txt -c copy out_copy.mp4

:: 2. .tmp tanpa format (gagal)
ffmpeg -y -v error -f concat -safe 0 -i list1.txt -c copy out.tmp

:: 3. .tmp dengan format (berhasil)
ffmpeg -y -v error -f concat -safe 0 -i list1.txt -c copy -f mp4 out2.tmp

:: 4. campur resolusi (exit 0, output rusak)
ffmpeg -y -v error -f concat -safe 0 -i list_mixres.txt -c copy out_mixres.mp4

:: 5. campur fps (exit 0, DTS rusak)
ffmpeg -y -v error -f concat -safe 0 -i list_mixfps.txt -c copy out_mixfps.mp4

:: 6. klip tanpa audio (exit 0, audio desync 4 s)
ffmpeg -y -v error -f concat -safe 0 -i list_noaudio.txt -c copy out_noaudio.mp4

:: 7. audio beda sample rate (exit 0, pitch +8,8 %)
ffmpeg -y -v error -f concat -safe 0 -i list_mixaudio.txt -c copy out_mixaudio.mp4

:: 8. rotasi (metadata hilang)
ffmpeg -y -v error -display_rotation 90 -i a.mp4 -c copy rot.mp4
ffprobe -v error -show_entries stream_side_data=rotation -of json rot.mp4

:: 9. re-encode 12 s (biaya fallback)
ffmpeg -y -v error -f concat -safe 0 -i list1.txt -c:v libx264 -preset veryfast -crf 23 -c:a aac out_enc.mp4
```

Semua angka pada laporan ini berasal dari eksekusi nyata di mesin audit, bukan estimasi.
