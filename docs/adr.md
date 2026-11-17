# Architecture Decision Records (ADR) — Video Combinator v2

## Ringkasan Keputusan Arsitektur (D1–D12)

### D1: Dua Tahap (Ingest + Render)
- **Keputusan**: Normalisasi setiap klip sumber sekali saat pertama ditemukan (`Ingest`), lalu gabungkan via `ffmpeg -c copy` saat render.
- **Rasional**: Menghilangkan seluruh kelas kegagalan parameter (resolusi beda, audio sample rate beda, rotasi metadata, VFR vs CFR).

### D2: Mode Default Fast (Stream Copy)
- **Keputusan**: Mode utama adalah `fast` (stream copy). Mode `quality` (re-encode penuh per kombinasi) disiapkan sebagai opsi masa depan.
- **Rasional**: Memastikan SLA kecepatan: 125 video selesai ≤ 90 detik.

### D3: Spesifikasi Kanonik per Produk
- **Keputusan**: Tiap produk dikunci ke spesifikasi: 1080×1920, 30 fps CFR, H.264 High@4.1, yuv420p, GOP 60, SAR 1:1, AAC-LC 48 kHz stereo 192 kbps, loudnorm −16 LUFS.
- **Rasional**: Kompatibilitas optimal untuk platform iklan (TikTok, Meta Ads, Reels) dan konsistensi audio.

### D4: Database Read-Only & Separasi Direktori
- **Keputusan**: `database/` bersifat read-only mutlak. Status disimpan di `state/`, file turunan di `cache/`, dan video jadi di `output/`.
- **Rasional**: Mencegah kehilangan atau korupsi aset asli pengguna; upload baru masuk secara terisolasi.

### D5: Manifest sebagai Single Source of Truth
- **Keputusan**: Status output (`DONE`, `FAILED`, `STALE`, `ORPHAN`) ditentukan oleh `manifest.json` dan fingerprint aset, bukan semata-mata keberadaan file di disk.
- **Rasional**: Menghindari false positive pada file terpotong (truncated) atau file hasil render versi lama ketika klip sumber berubah.

### D6: Penamaan Deterministik + Hash8 + Slug ASCII
- **Keputusan**: Pola nama: `<productSlug>__<hookSlug>__<bodySlug>__<ctaSlug>__<hash8>.mp4`. Slug dibatasi maks 28 karakter per bagian.
- **Rasional**: Menghindari tabrakan nama, mencegah ambiguitas pemisah `__`, dan aman dari batas Windows `MAX_PATH` (260 karakter).

### D7: Bundled FFmpeg & FFprobe
- **Keputusan**: Binary `ffmpeg.exe` dan `ffprobe.exe` dibundel di folder `bin/` dan dipanggil dengan path absolut.
- **Rasional**: Memastikan aplikasi dapat langsung berjalan di mesin pengguna non-teknis tanpa perlu setting environment variable `PATH`.

### D8: Repositori Terpisah
- **Keputusan**: Dibangun di folder mandiri `D:\Jobs\video-combinator`.
- **Rasional**: Menghindari konflik dependensi (Remotion, React, Puppeteer) dan bentrok port lokal.

### D9: Stack Ringan & Mandiri
- **Keputusan**: Node.js 24 ESM, TypeScript, Express 5, Zod, vanilla HTML/TS frontend, dan Tailwind lokal.
- **Rasional**: 100% offline, tidak butuh database eksternal, startup instan (< 1 detik).

### D10: Loopback Security & Port Fallback
- **Keputusan**: Server hanya listen di `127.0.0.1`, port default 3210 (fallback 3211–3219). Wajib header `X-App-Request: 1` untuk operasi mutasi.
- **Rasional**: Menolak DNS rebinding, CSRF dari browser luar, dan menghindari bentrok port dengan dev server lain.

### D11: Worker Concurrency
- **Keputusan**: Worker render default 3 (rentang 1–6), worker ingest 4.
- **Rasional**: Mencegah bottleneck I/O disk SSD dan lonjakan CPU berlebih.

### D12: Presisi Pelaporan (CSV)
- **Keputusan**: Durasi diukur dari file output aktual via ffprobe; `created_at` berformat ISO 8601 dengan offset timezone lokal; UTF-8 BOM untuk kompatibilitas Excel Indonesia.
- **Rasional**: Akurasi data untuk tim periklanan dan media buyer.

---

## Catatan Lisensi FFmpeg
- Binary FFmpeg yang digunakan dikompilasi dengan opsi `--enable-gpl --enable-version3`.
- Sistem memanggil FFmpeg secara eksternal sebagai proses terpisah (`child_process.spawn`) melalui command-line interface (CLI) tanpa melakukan dynamic/static linking ke pustaka libav*.
- Hal ini sepenuhnya memenuhi ketentuan lisensi GNU General Public License (GPL) v3 untuk interaksi proses independen.
