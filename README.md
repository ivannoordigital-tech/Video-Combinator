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

Browser Anda (Chrome/Edge) akan otomatis terbuka ke alamat `http://127.0.0.1:3210`.

### Cara 2: Lewat Terminal (CLI)
```bash
cd D:\Jobs\video-combinator
npm start
```
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
   - Buka `http://127.0.0.1:3210` lalu klik tombol **🔄 Rescan**.
3. **Generate Video Baru**:
   - Sistem akan otomatis mendeteksi:
     - *125 video lama sudah ada $\rightarrow$ **di-skip otomatis***
     - *25 kombinasi baru siap diproses*
   - Klik tombol **"🚀 Generate Video Baru"** $\rightarrow$ Selesai dalam ~2–3 detik!

---

## 🛡️ Best Practices & Windows Defender Tips
Untuk kecepatan I/O maksimal saat render ratusan video, disarankan menambahkan folder kerja ini ke Exclusion Windows Defender:
1. Buka **Windows Security** $\rightarrow$ **Virus & threat protection**.
2. Klik **Manage settings** pada *Virus & threat protection settings*.
3. Pada bagian **Exclusions**, klik **Add an exclusion** $\rightarrow$ **Folder**.
4. Pilih folder `D:\Jobs\video-combinator\output` dan `cache`.
