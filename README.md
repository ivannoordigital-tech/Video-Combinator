# Automated Multi-Product Video Combinator (v2.0)

Aplikasi desktop & web lokal berkecepatan tinggi untuk menghasilkan ratusan variasi video iklan massal (**Hook + Body/Isi + CTA**) secara otomatis dengan sistem isolasi berbasis produk, *incremental build*, dan *lossless stream copy*.

---

## ⚡ Hasil Uji Benchmark (Hardware Lokal)
- **125 Video (1080×1920 @ 30fps)**: Selesai hanya dalam **6,08 detik**! 🚀
- **Throughput**: **20,57 video / detik**.
- **Penggunaan Memori (RSS)**: Hanya **69 MB** (sangat ringan).

---

## 🚀 Cara Menjalankan Aplikasi

### Cara 1: Sekali Klik (Rekomendasi untuk Sehari-hari)
Cukup **klik dua kali (double-click)** file:
👉 **`Buka_Dashboard.bat`**

Launcher akan:
1. Memeriksa Node.js, `bin\ffmpeg.exe`, dan `bin\ffprobe.exe`.
2. Menjalankan `npm install` jika `node_modules` belum ada.
3. Menjalankan `npm run build` jika `dist\src\server.js` belum ada atau lebih lama dari source di `src\`.
4. Menjalankan server produksi (`node dist\src\server.js`) **tanpa watch**, sehingga render tidak terputus saat ada file berubah.
5. Menunggu `/api/health` merespons, lalu membuka browser ke **port aktual** (3210 sampai 3219).

Server memilih port pertama yang bebas. Jika 3210 sedang dipakai, aplikasi otomatis pindah ke 3211, 3212, dan seterusnya. Alamat yang dipakai selalu tertulis di jendela launcher:
`Dashboard berjalan di: http://127.0.0.1:<port>`

Jalankan **satu instance saja**. Jika launcher mendeteksi sudah ada proses yang mendengarkan port 3210 sampai 3219, launcher akan memberi peringatan dan meminta konfirmasi sebelum menyalakan instance baru. Launcher tidak menghentikan proses yang sudah berjalan.

### Cara 2: Lewat Terminal (CLI)
```bash
cd D:\Jobs\video-combinator
npm install     # cukup sekali saat pertama kali
npm run build   # setiap kali kode di src\ berubah
npm start       # menjalankan node dist/src/server.js (tanpa watch)
```
Buka `http://127.0.0.1:3210`. Jika port itu terpakai, lihat baris `Dashboard berjalan di: ...` di terminal dan buka port tersebut (3211 sampai 3219).

Untuk pengembangan UI atau server, `npm run dev` masih tersedia (tsx watch). Jangan memakai mode watch saat render berjalan karena restart server dapat mematikan proses render.

Atau menjalankan perintah CLI langsung:
```bash
npm run cli -- doctor                                # Cek kesehatan FFmpeg
npm run cli -- plan --product nama-produk            # Cek antrean render
npm run cli -- render --product nama-produk --scope new  # Render video baru
```

---

## 📁 Struktur Direktori & "Database" Video Mentah

```text
D:\Jobs\video-combinator\
├── Buka_Dashboard.bat          <-- Klik 2x untuk membuka dashboard
├── bin\                        <-- FFmpeg 9.0 & FFprobe mandiri
├── database\                   <-- Bank video mentah (Read-only)
│   ├── produk-sepatu\
│   │   ├── hooks\ (h1.mp4, h2.mp4...)
│   │   ├── bodies\ (b1.mp4, b2.mp4...)
│   │   └── ctas\ (c1.mp4, c2.mp4...)
│   └── produk-tas\
├── output\                     <-- Hasil video gabungan final
│   └── produk-sepatu\
│       ├── produk-sepatu__hook-1__body-1__cta-1__a1b2c3d4.mp4
│       ├── manifest.json       <-- Single source of truth riwayat render
│       └── report_iklan.csv    <-- Laporan metadata untuk Ads Manager
└── state\                      <-- Metadata & konfigurasi per produk
```

---

## 🔄 Bagaimana Cara Menambah Video Baru?

1. **Masukkan File Video Baru**:
   - Salin file video baru Anda ke folder produk yang sesuai (misal: `database/produk-sepatu/hooks/hook-06.mp4`).
2. **Buka Dashboard**:
   - Buka alamat yang tertulis di jendela launcher (biasanya `http://127.0.0.1:3210`, bisa 3211 sampai 3219 jika port tersebut terpakai), lalu klik tombol **🔄 Rescan**.
3. **Generate Video Baru**:
   - Sistem akan otomatis mendeteksi:
     - *125 video lama sudah ada $\rightarrow$ **di-skip otomatis***
     - *25 kombinasi baru siap diproses*
   - Klik tombol **"🚀 Generate Video Baru"** $\rightarrow$ Selesai dalam ~2–3 detik!

---

## 🧯 Troubleshooting

**Port 3210 terpakai, dashboard pindah ke port lain**
Server mencoba port 3210 sampai 3219 secara berurutan. Buka alamat yang tertulis di jendela launcher (`Dashboard berjalan di: http://127.0.0.1:<port>`), bukan selalu 3210. Jangan menjalankan `Buka_Dashboard.bat` dua kali. Jika semua port terpakai, server berhenti dengan pesan `Semua port 3210-3219 sedang digunakan`; tutup instance lain lalu jalankan ulang. Launcher memberi peringatan jika sudah ada listener di rentang tersebut dan tidak mematikan proses milik Anda.

**409 E_JOB_RUNNING**
Permintaan plan atau render ditolak karena masih ada job yang berjalan untuk produk tersebut. Tunggu sampai selesai, atau klik tombol batalkan render. Setelah status job `DONE`, `FAILED`, atau `CANCELLED`, muat ulang halaman.

**403 E_FORBIDDEN (Host / Origin)**
Aplikasi hanya menerima akses melalui `http://127.0.0.1:<port>` atau `http://localhost:<port>`. Jangan memakai IP LAN, nama host, atau membuka file HTML langsung. Untuk POST, PUT, PATCH, dan DELETE ke `/api/*`, header `X-App-Request: 1` wajib ada; UI sudah mengirimnya otomatis. Jika header `Origin` dikirim, nilainya harus loopback.

**416 E_RANGE_INVALID**
Header `Range` tidak valid atau di luar ukuran file. Muat ulang halaman atau pemutar video. Jika terus berulang, periksa file sumber di `database`; ganti file yang rusak atau terpotong, lalu jalankan Rescan.

**422 E_SCAN_REQUIRED**
Cache normalisasi untuk spesifikasi terbaru belum ada. Ini normal terjadi sekali setelah update yang mengubah nama cache. Klik **Pindai Ulang**, tunggu selesai, lalu klik Generate lagi. Render tidak akan menulis status FAILED hanya karena cache lama.

**Folder tidak bisa dibuka: 404 E_PATH_INVALID atau 500 E_OPEN_FAILED**
`404 E_PATH_INVALID` berarti folder target belum ada, misalnya `output/<slug>` atau `database/<slug>/hooks`. Buat produk lewat dashboard agar folder otomatis dibuat, atau buat folder tersebut secara manual lalu coba lagi. `500 E_OPEN_FAILED` berarti File Explorer gagal dibuka (misalnya timeout 2 detik); coba lagi dan periksa pesan `[open-folder]` di konsol server.

**Log render**
Log per produk ada di `logs/<slug>/render-YYYYMMDD.log`. File dirotasi ke `.log.1` jika melebihi 10 MB. Log berisi status tiap item dan potongan stderr FFmpeg (8 KB terakhir) untuk item yang gagal. Status output resmi ada di `output/<slug>/manifest.json` (`DONE`, `FAILED`, `STALE`, `ORPHAN`). Error server 4xx/5xx dan kegagalan job juga tampil di konsol launcher.

**Build dan versi Node**
Launcher menjalankan `npm run build` otomatis jika `dist` belum ada atau lebih lama dari source. Jika build gagal, perbaiki error TypeScript yang tampil, lalu jalankan ulang. Node.js 24 dianjurkan; versi lebih lama hanya diberi peringatan. Setelah mengubah kode, jalankan `npm run build` sebelum `npm start`.

Ringkasan perubahan teknis dan langkah verifikasi ada di [docs/FIXES.md](docs/FIXES.md).

---

## 🛡️ Best Practices & Windows Defender Tips
Untuk kecepatan I/O maksimal saat render ratusan video, disarankan menambahkan folder kerja ini ke Exclusion Windows Defender:
1. Buka **Windows Security** $\rightarrow$ **Virus & threat protection**.
2. Klik **Manage settings** pada *Virus & threat protection settings*.
3. Pada bagian **Exclusions**, klik **Add an exclusion** $\rightarrow$ **Folder**.
4. Pilih folder `D:\Jobs\video-combinator\output` dan `cache`.
