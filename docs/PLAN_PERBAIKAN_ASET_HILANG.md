# Plan Perbaikan: "File tidak ditemukan di folder database"

Status: draft, belum diimplementasikan
Terkait: `src/core/scan.ts`, `src/server.ts`, `public/index.html`
Sumber laporan: dashboard client menampilkan banyak kartu `ERROR` dengan pemutar video hitam (0:00), padahal aset lain masih bisa di-generate.

## 1. Akar masalah

1. Daftar kartu di UI dibaca dari `state/<slug>/assets.json`, bukan dari isi folder (`public/index.html:1494-1497`).
2. `ScanEngine.scanProductAssets` hanya menandai entri yang filenya tidak ada sebagai `ERROR` dan **tidak pernah menghapusnya** (`src/core/scan.ts:168-177`).
   Akibatnya entri basi menumpuk permanen, badge "N File" tetap menghitung entri basi (`public/index.html:1511`), dan kartu video menunjuk file yang 404 (`public/index.html:1564`).
3. Pesan error tidak menyebut folder mana yang dipindai, sehingga client tidak bisa membedakan:
   - file benar-benar dihapus/dipindah/di-rename,
   - file ada di subfolder (scan tidak rekursif, `src/core/scan.ts:77`),
   - file ada di folder produk lain,
   - drive jaringan/OneDrive sedang tidak terbaca saat scan.
4. Scan juga berbahaya saat folder tidak terbaca: `readdirSync` yang gagal setelah folder kosong membuat **semua** entri lama ditandai hilang (tidak ada guard).
5. Tidak ada jalur UI untuk membersihkan entri hilang; satu-satunya cara adalah mengembalikan nama file persis lalu Pindai Ulang.

Tujuan perbaikan: kondisi "entri hilang" menjadi jelas, bisa dibersihkan dengan aman, dan tidak pernah terpicu palsu karena folder tidak terbaca.

## 2. Ruang lingkup

Termasuk:
- diagnostik scan (folder yang dipindai, file yang terlihat, entri hilang),
- endpoint + tombol eksplisit "Bersihkan entri hilang",
- UI banner peringatan, placeholder kartu hilang (tanpa pemutar hitam), badge jumlah,
- guard agar scan tidak menandai semua aset hilang saat folder tidak terbaca,
- test unit + checklist QA,
- dokumentasi troubleshooting.

Tidak termasuk:
- auto-prune saat scan (ditolak, lihat §8),
- pembersihan file cache yatim di `cache/<slug>/ingest` (follow-up terpisah),
- perubahan format `assets.json` (tetap schemaVersion 1),
- upload aset lewat browser.

## 3. Desain

### 3.1 Core: laporan scan + prune (`src/core/scan.ts`)

Tambah tipe hasil scan tanpa memutus API lama:

```ts
export interface ScanSkippedFile { file: string; reason: "hidden" | "temporary" | "ext" }

export interface ScanFolderReport {
  kind: AssetKind;
  dirPath: string;          // path absolut, untuk ditampilkan di UI
  exists: boolean;
  readable: boolean;
  filesSeen: string[];      // file valid yang ikut diproses
  skipped: ScanSkippedFile[];
}

export interface ScanMissingEntry { kind: AssetKind; file: string; sizeBytes: number }

export interface ScanReport {
  specHash: string;
  scannedAt: string;
  folders: ScanFolderReport[];
  missing: ScanMissingEntry[];
  counts: Record<AssetKind, { ready: number; error: number; missing: number }>;
}

export interface ScanResult { registry: AssetsRegistry; report: ScanReport }
```

Perubahan perilaku:

- `scanProductAssetsDetailed(productRoot, product, currentRegistry): Promise<ScanResult>` — implementasi baru.
- `scanProductAssets(...)` tetap ada dan hanya mengembalikan `.registry` (dipakai test & CLI, tidak perlu diubah).
- Baca folder dibungkus helper `listFolderFiles(dirPath)`:
  - `readdirSync` dengan `withFileTypes`; error `ENOENT/ENOTDIR/EACCES/EPERM` → **throw** `ScanFolderUnreadableError` berisi `dirPath` dan kode asli. Scan dibatalkan, `assets.json` **tidak** ditulis. Ini mencegah seluruh aset jadi ERROR saat drive/OneDrive putus.
  - Folder tidak ada → dibuat (perilaku sekarang) dan dicatat `exists: false` di report.
- Entri hilang tetap ditandai ERROR (kompatibel), tetapi pesan diperjelas:

```
File tidak ditemukan di folder database. Kembalikan nama file lalu Pindai Ulang, atau hapus entri dengan "Bersihkan entri hilang".
```

  Path absolut tidak disimpan di `assets.json` (state bisa dipindah mesin); path ada di `report.folders[].dirPath`.
- Clone item sebelum dimutasi (`{ ...item }`) agar `currentRegistry` milik pemanggil tidak ikut berubah (bug sampingan saat ini).

Fungsi prune terpisah (dipakai endpoint, bisa dites tanpa HTTP):

```ts
export interface PruneResult {
  registry: AssetsRegistry;
  removed: { kind: AssetKind; file: string; sizeBytes: number }[];
}

export function pruneMissingAssets(
  productRoot: string,
  product: ProductConfig,
  currentRegistry: AssetsRegistry
): PruneResult
```

Aturan prune:
- Cek per kind langsung ke filesystem (bukan mengandalkan `item.error`).
- Folder tidak ada / tidak terbaca → **lewati kind tersebut** (entri untuk kind itu tidak dihapus) dan catat di `skippedKinds`; kind lain tetap diproses. Ini membuat prune parsial dan aman saat drive/OneDrive putus.
- Hapus hanya entri yang namanya tidak ada di `readdirSync` folder terkait.
- File yang ada tetapi `status: ERROR` (korup/ekstensi salah) **tidak** dihapus.
- Tidak menyentuh `cache/` maupun `output/`.

### 3.2 Server (`src/server.ts`)

| Endpoint | Perubahan |
|---|---|
| `POST /api/products/:slug/scan` | pakai `scanProductAssetsDetailed`; respons `{ ok, registry, report }`; error folder tidak terbaca → `500 E_SCAN_FOLDER_UNREADABLE` + path |
| `GET /api/products/:slug` | tambah `diagnostics: { readable, databaseDir, missingCount, missingByKind, folders: {kind, dirPath}[], missingKeys: { kind, file }[] }` dihitung dengan `readdirSync` + `existsSync` |
| `POST /api/products/:slug/assets/prune-missing` (baru) | guard slug & produk, guard `activeJobs`/`pendingRenders` → `409 E_JOB_RUNNING`, jalankan `pruneMissingAssets`, tulis atomic, respons `{ ok, removed, skippedKinds, registry, diagnostics }`, log ringkas `[prune] slug: N entri dihapus` |

Catatan:
- `diagnostics.readable === false` (mis. drive offline) → UI tidak boleh menampilkan "hilang", cukup "folder tidak terbaca".
- Tidak ada endpoint baru yang menulis tanpa header `X-App-Request`, mengikuti middleware yang ada.

### 3.3 UI (`public/index.html` + CSS di file yang sama)

1. **Banner aset hilang** di atas tiga kolom, tampil bila `diagnostics.missingCount > 0`:
   - Teks: `N entri tercatat di database tetapi filenya tidak ada di <databaseDir>\<slug>\...`
   - Daftar maksimal 5 nama + `dan X lainnya`.
   - Tombol: `Buka Folder` (pakai `openDatabaseDir`), `Bersihkan Entri Hilang` (danger), `Pindai Ulang`.
   - Bila `readable === false`: banner berbeda warna, teks `Folder database tidak terbaca. Periksa drive/OneDrive, lalu Pindai Ulang.` tanpa tombol bersihkan.
2. **Modal konfirmasi** `#modalConfirm` mengikuti gaya `#modalProduct`, helper:

```js
function requestConfirm({ title, body, confirmLabel, danger }) // -> Promise<boolean>
```

   Dipakai sebelum prune: "Hapus N entri hilang dari daftar? File di disk tidak disentuh."
3. **Handler prune**: `POST .../assets/prune-missing` → toast `N entri hilang dihapus.`; bila `skippedKinds` tidak kosong, tampilkan warning berisi folder yang dilewati → `loadProductDetails()`.
4. **Rescan** (`rescanCurrentProduct`): toast hasil memakai `report`:
   `Pemindaian selesai: X file terbaca, Y entri hilang.` Bila `Y > 0`, toast warning dengan action `Bersihkan`.
5. **Kartu aset** (`renderClips`): untuk entri yang ada di `missingKeys`, jangan render `<video>`; tampilkan state kosong "File tidak ada di folder" + tombol `Buka Folder`. Entri READY/ERROR-lain tetap seperti sekarang.
6. **Badge** per kolom: `7 File · 5 hilang` (chip merah) bila ada entri hilang.

### 3.4 Skema data

Tidak ada perubahan `assets.json`. `AssetsRegistrySchema` tetap `schemaVersion: 1`. Entri yang di-prune hilang dari file; slug akan dibuat ulang otomatis saat file dikembalikan dan di-scan.

## 4. Skenario UX yang harus terpenuhi

1. File di-rename di Explorer lalu Pindai Ulang → entri lama jadi "hilang", entri baru muncul READY, banner menawarkan bersihkan.
2. File dihapus permanen → kartu hilang, tombol bersihkan menghapus kartu tanpa menyentuh file lain.
3. Drive jaringan/OneDrive terputus → scan gagal dengan pesan jelas, `assets.json` tidak berubah, banner "tidak terbaca".
4. File ada di subfolder → tetap tidak terbaca (perilaku scan), tetapi banner menunjukkan path persis sehingga client bisa memindahkannya.
5. Semua file sehat → tidak ada banner, badge normal.

## 5. Test

Unit (`tests/`, memakai folder fixture sementara seperti pola test yang ada):

- `scanProductAssetsDetailed`: jumlah `folders`, `filesSeen`, `skipped` (file `.txt`, `.part`, dotfile) benar.
- Hapus 1 file setelah scan → entri tersebut `ERROR` + masuk `report.missing`, entri lain tetap `READY`.
- `pruneMissingAssets`:
  - menghapus hanya entri yang filenya tidak ada,
  - tidak menghapus entri ERROR yang filenya masih ada (mis. magic bytes rusak),
  - melewati kind yang foldernya dihapus/diganti file dan mempertahankan entrinya (masuk `skippedKinds`),
  - `currentRegistry` pemanggil tidak termutasi.
- `scanProductAssets` wrapper tetap kompatibel (test lama T1.6–T1.9 harus lulus tanpa perubahan).
- Scan dengan folder dihapus saat scan berjalan → error `E_SCAN_FOLDER_UNREADABLE` (simulasi: ganti folder dengan file, `readdirSync` → `ENOTDIR`).

Manual QA:

| # | Langkah | Harapan |
|---|---|---|
| 1 | Tambah 3 file, Pindai Ulang | 3 kartu READY, tanpa banner |
| 2 | Rename 1 file di Explorer, Pindai Ulang | 1 kartu hilang + 1 READY, banner "1 entri hilang" |
| 3 | Klik Bersihkan → konfirmasi | kartu hilang lenyap, `assets.json` bersih, file disk utuh |
| 4 | Ganti folder `database/<slug>/hooks` dengan file lalu Pindai Ulang | toast `E_SCAN_FOLDER_UNREADABLE`, `assets.json` tidak berubah |
| 5 | Generate | jumlah kombinasi tidak berubah dibanding sebelum prune |

## 6. Dokumentasi

- `README.md`: bagian troubleshooting "File tidak ditemukan di folder database" berisi penyebab, cara cek `rootDir` via `/api/health`, dan langkah Bersihkan Entri Hilang.
- `docs/FIXES.md`: entri baru tentang guard folder tidak terbaca + prune eksplisit.

## 7. Urutan kerja & estimasi

| Fase | Isi | Estimasi |
|---|---|---|
| 1 | `scan.ts`: report, guard readdir, prune, clone item | 0,5 hari |
| 2 | `server.ts`: scan detail, diagnostics, endpoint prune | 0,5 hari |
| 3 | UI: banner, modal konfirmasi, kartu placeholder, badge, toast | 1 hari |
| 4 | Test unit + manual QA | 0,5 hari |
| 5 | Dokumentasi | 0,25 hari |

Total ±2,75 hari kerja. Fase 1–2 bisa rilis lebih dulu (API + diagnosa), UI menyusul.

## 8. Alternatif yang ditolak

- **Auto-prune setiap scan**: berisiko menghapus riwayat hanya karena drive/OneDrive sedang tidak tersedia. Prune harus aksi eksplisit user.
- **Menyimpan path absolut di `error` aset**: `assets.json` bisa ikut tersalin ke mesin lain; path jadi menyesatkan.
- **Menyembunyikan entri hilang di UI saja**: `assets.json` tetap kotor dan `GET /api/products` masih melaporkan jumlah file yang salah.

## 9. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Folder sementara tidak terbaca lalu di-prune | entri terhapus padahal file ada | prune melewati kind yang tidak terbaca (entri dipertahankan) + confirm eksplisit |
| Dua tab melakukan prune bersamaan | tulis JSON saling menimpa | `writeJsonAtomic` + reload detail setelah aksi; endpoint singkat |
| Perubahan bentuk respons `scan` | UI lama | UI hanya memakai `registry`; `report` aditif |
| Refactor `scan.ts` memecah test | regresi | pertahankan wrapper `scanProductAssets` |
