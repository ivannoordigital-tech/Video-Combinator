# Catatan Perbaikan Audit 2026-11

Dokumen ini merangkum perubahan besar pada branch `fix/audit-2026-11`. Fokus perbaikan: stabilitas server, pembatalan render yang bersih, keamanan loopback dan path, integritas cache serta output, dan observability. Format database dan struktur folder pengguna tidak berubah.

## 1. Crash guard dan penanganan error

- Job render dijalankan di background setelah response `202` terkirim, sehingga kegagalan awal engine tidak mendahului response dan tidak mematikan server.
- Seluruh eksekusi job dibungkus `try/catch/finally`. Error item dicatat sebagai `FAILED`, error tak terduga menandai job `FAILED`, dan server tetap hidup.
- Job tidak lagi dianggap `DONE` palsu jika semua item gagal. Aturan status: `FAILED` bila `failed > 0` dan `done === 0`, selain itu `DONE`.
- Error middleware global mengembalikan JSON konsisten `{ "error": { "code", "message", "details?" } }`. Body JSON rusak menjadi `400 E_VALIDATION_ERROR`, payload terlalu besar menjadi `413 E_UPLOAD_TOO_LARGE`, dan endpoint `/api/*` yang tidak ada menjadi `404 E_NOT_FOUND` dalam JSON.
- Penulisan SSE, pembacaan file media, pembukaan folder, dan penulisan log dibungkus guard. Kegagalan operasi tersebut tidak boleh mematikan proses utama.
- Error 4xx dicatat ringkas dengan `console.warn`; error 5xx dicatat lengkap dengan stack.

## 2. Cancel bersih

- `RenderEngine.cancelAndWait()` menghentikan proses lalu menunggu worker benar-benar selesai, dengan timeout.
- Di Windows, seluruh process tree dihentikan memakai `taskkill /PID <pid> /T /F`, dengan fallback `proc.kill()`.
- Server memberi waktu sampai 30 detik karena preflight `ffprobe` punya timeout internal. Ada guard tambahan agar request cancel tidak menggantung.
- Status job menjadi `CANCELLED`, `current` diubah ke `null`, dan `completedAt` diisi. Event SSE yang dikirim hanya `cancelled`, tanpa `done` ganda.
- Request cancel kedua menunggu promise yang sama, sehingga tidak ada event atau penghapusan job ganda.
- Item yang sudah lolos verifikasi sebelum cancel tetap dicatat `DONE` di manifest. Item yang belum selesai tidak dicatat sebagai output valid.
- Lock job dilepas setelah cancel selesai, sehingga render baru bisa dimulai.

## 3. Keamanan Host, Origin, dan path

- Host header harus persis `127.0.0.1` atau `localhost`. Pencocokan tidak memakai prefix, sehingga `127.0.0.1.evil.com` ditolak dengan `403 E_FORBIDDEN`.
- Semua mutasi `/api/*` (`POST`, `PUT`, `PATCH`, `DELETE`) wajib menyertakan header `X-App-Request: 1`.
- Jika header `Origin` dikirim, nilainya harus `http://127.0.0.1:<port>` atau `http://localhost:<port>`. Header `Sec-Fetch-Site`, jika ada, harus `same-origin` atau `none`.
- Endpoint media memvalidasi slug, whitelist jenis media (`hook`, `body`, `cta`), dan nama file. Nama file dengan `/`, `\`, `..`, atau null byte ditolak.
- Setelah `path.resolve`, file harus berada di dalam folder media. Pemeriksaan `realpath` juga menolak symlink atau junction yang keluar dari folder tersebut.
- Penulisan JSON state memakai file sementara lalu rename atomik, sehingga file tidak setengah tertulis saat proses berhenti.

## 4. Cache ingest berbasis specHash

- Nama cache kanonik sekarang `cache/<slug>/ingest/<sha8>__<specHash8>__<slug>.mp4`.
- `specHash` dihitung dari spesifikasi video dan audio produk (codec, CRF, preset, profile, level, GOP, fps, audio bitrate, dan parameter terkait). Perubahan parameter menghasilkan nama cache baru, sehingga output lama tidak tercampur dengan spesifikasi baru.
- Scan membandingkan `registry.specHash` dan keberadaan file cache kanonik. Jika spesifikasi berubah atau cache hilang, aset di-ingest ulang dan ditandai sesuai statusnya.
- File hasil encode divalidasi dengan `ffprobe` sebelum dipakai. Penulisan memakai file `.part` lalu rename agar cache tidak pernah berisi file setengah jadi.
- Cache spesifikasi lama untuk sumber yang sama (`sha8` dan slug) dibersihkan, hanya di dalam folder ingest produk tersebut.
- Kompatibilitas cache lama: nama lama tanpa `specHash` tetap dibuat sebagai alias hardlink (fallback copy) ke file kanonik terbaru. Tujuannya agar kode atau cache lama tidak langsung pecah. Alias bersifat best-effort; jika file terkunci, alias lama dibiarkan dan render memakai nama kanonik.
- Migrasi setelah update: jika cache kanonik `specHash` belum ada, endpoint render menolak dengan `422 E_SCAN_REQUIRED` dan tidak menulis entri FAILED. Klik **Pindai Ulang** sekali, lalu render lagi.

## 5. Verifikasi output DONE

- `OutputVerifier` memeriksa keberadaan file, tipe file reguler, ukuran minimum 50 KB, integritas box MP4 (mendeteksi `mdat` terpotong), stream video dan audio, durasi dengan toleransi 0,25 detik, fps dengan toleransi 5 fps (selisih lebih dari 5 fps ditolak), serta parameter kanonik produk.
- Plan memverifikasi ulang semua entri manifest berstatus `DONE` sebelum dianggap selesai. Hasil verifikasi di-cache berdasarkan `mtime` dan ukuran, dengan batas jumlah entri.
- Entri `DONE` yang filenya hilang, terpotong, atau gagal probe akan dirender ulang, bukan dilewati. Ini mencegah false positive dari manifest lama.
- Render memverifikasi file `.part` sebelum rename. Hanya file yang lolos verifikasi yang dicatat `DONE`, lengkap dengan durasi, ukuran, dan `specHash` hasil verifikasi.
- Report CSV secara default hanya memuat output `DONE`.

## 6. stderr dan log render

- stderr FFmpeg disimpan sampai 8 KB terakhir per item yang gagal. Ringkasan pesan error dibatasi sekitar 800 karakter agar event SSE tetap kecil.
- Log ditulis ke `logs/<slug>/render-YYYYMMDD.log`. File dirotasi ke `.log.1` jika melebihi 10 MB.
- Log berisi status per item, pesan error, dan potongan stderr. Penulisan log bersifat best-effort dan tidak boleh menggagalkan render.
- Kegagalan menyimpan manifest atau report dicatat sebagai `WARN` di log, bukan crash.

## 7. Range 416 dan streaming media

- Parser mendukung `bytes=start-end`, `bytes=start-`, dan suffix `bytes=-N`.
- Header Range yang tidak valid, di luar ukuran file, atau diminta pada file kosong menghasilkan `416 E_RANGE_INVALID` dengan `Content-Range: bytes */<size>` dan `Accept-Ranges: bytes`.
- Range valid menghasilkan `206` dengan `Content-Range`, `Content-Length`, dan `Accept-Ranges` yang benar. Tanpa Range, file dikirim `200`.
- Stream dihentikan saat klien memutus koneksi. Error baca sebelum header terkirim menjadi `500 E_MEDIA_READ_FAILED`; setelah header terkirim, koneksi dihentikan agar tidak menggantung.

## 8. Endpoint folder

- `POST /api/products/:slug/open-output` membuka folder output produk.
- `POST /api/products/:slug/open-database?kind=hooks|bodies|ctas` membuka subfolder database. Nilai `kind` yang tidak valid ditolak `400 E_VALIDATION_ERROR`.
- Folder yang tidak ada atau bukan direktori menghasilkan `404 E_PATH_INVALID`.
- Keberhasilan ditentukan dari event `spawn` proses Explorer, bukan exit code. Ada timeout 2 detik dan dedupe 1 detik untuk klik ganda.
- Kegagalan membuka Explorer menghasilkan `500 E_OPEN_FAILED`. Percobaan ulang diizinkan segera setelah gagal.
- Proses dijalankan dengan `spawn("explorer.exe", [path])`, bukan string shell, sehingga path tidak dapat dipakai untuk injeksi perintah.

## 9. SSE: snapshot, error, dan done

- Saat klien terhubung, server langsung mengirim event `snapshot` berisi job aktif atau `null`.
- Heartbeat dikirim setiap 15 detik untuk menjaga koneksi.
- Event `item` dan `progress` dikirim selama render. Kegagalan per item dikirim sebagai `error` tanpa menghentikan job.
- Event `done` hanya dikirim sekali di akhir job yang selesai, baik `DONE` maupun `FAILED`. Job yang dibatalkan hanya mengirim `cancelled`.
- Klien yang terputus dibersihkan dari daftar SSE. Penulisan ke koneksi yang sudah tertutup dilewati atau ditangani tanpa crash.

## 10. Kontrak API utama

| Status | Kode | Kondisi |
| --- | --- | --- |
| 400 | `E_VALIDATION_ERROR`, `E_PATH_INVALID` | Input tidak valid, slug atau nama file tidak aman |
| 403 | `E_FORBIDDEN` | Host/Origin bukan loopback, atau header `X-App-Request` tidak ada |
| 404 | `E_NOT_FOUND`, `E_PATH_INVALID` | Produk, file media, endpoint, atau folder tidak ditemukan |
| 409 | `E_JOB_RUNNING` | Plan atau render diminta saat job produk masih berjalan |
| 413 | `E_UPLOAD_TOO_LARGE` | Body permintaan terlalu besar |
| 416 | `E_RANGE_INVALID` | Header Range tidak valid atau di luar ukuran file |
| 422 | `E_LIMIT_EXCEEDED`, `E_NO_ITEMS`, `E_SCAN_REQUIRED` | Kombinasi melebihi batas, tidak ada item baru, atau cache normalisasi belum siap |
| 500 | `E_*` spesifik | Kegagalan server, scan, plan, render, report, atau buka folder |

Semua error API memakai bentuk JSON yang sama: `{ "error": { "code": "...", "message": "...", "details": ... } }`.

## Verifikasi manual singkat

1. Jalankan `npm run build` lalu `node dist/src/server.js`. Pastikan log menampilkan `Dashboard berjalan di: http://127.0.0.1:<port>` dan `GET /api/health` mengembalikan `200`.
2. Uji fallback port: dengarkan port 3210 dengan proses lain, lalu jalankan server. Server harus memakai 3211 dan launcher membuka 3211.
3. Uji satu instance: jalankan `Buka_Dashboard.bat` saat server masih hidup. Launcher harus memberi peringatan dan tidak menghentikan proses lama.
4. Uji 403: `curl.exe -i -H "Host: evil.local" http://127.0.0.1:<port>/api/health`. Lalu `POST /api/products/<slug>/render` tanpa `X-App-Request`, harus `403 E_FORBIDDEN`.
5. Uji Range: minta `Range: bytes=0-1023` dan pastikan `206`. Minta `Range: bytes=999999999-` dan pastikan `416` dengan `Content-Range: bytes */<size>`.
6. Uji 409: mulai render dari UI, lalu kirim `POST render` lagi. Harus `409 E_JOB_RUNNING`. Setelah cancel, status harus `CANCELLED` dan tidak ada event `done` ganda.
7. Uji folder: panggil `open-output` untuk produk yang folder output-nya belum ada, harus `404 E_PATH_INVALID`. Setelah folder dibuat, endpoint harus mengembalikan `200`.
8. Uji integritas: potong atau hapus satu file output `DONE` di produk uji, lalu buka plan. Item tersebut harus masuk antrean render ulang, bukan dilewati.
9. Uji cache: ubah salah satu parameter video produk, jalankan scan, dan pastikan muncul nama cache dengan `specHash` baru. Alias nama lama tetap ada.
10. Uji log: buat satu item gagal di produk uji, lalu periksa `logs/<slug>/render-YYYYMMDD.log` untuk status, pesan error, dan potongan stderr.

## Perintah test

```bash
npm run typecheck
npm test
npm run build
```

Untuk subset yang berkaitan langsung dengan perbaikan ini:

```bash
npx vitest run tests/core_integrity.test.ts tests/render_cancel.test.ts tests/ingest.test.ts
```

Test menggunakan `fixtures/`, `bin/ffmpeg.exe`, dan `bin/ffprobe.exe`, serta membuat direktori sementara di `cache/`.

## Yang belum tercakup

- Single-instance lock di server belum ada. Launcher hanya mendeteksi listener dan meminta konfirmasi; dua instance masih mungkin dijalankan jika pengguna memilih lanjut.
- State job masih in-memory. Jika server direstart saat render, job hilang dari UI, meskipun file output yang sudah selesai tetap tercatat di manifest.
- Port fallback membuat bookmark lama bisa menunjuk ke instance yang berbeda. Selalu gunakan alamat yang tertulis di log launcher.
