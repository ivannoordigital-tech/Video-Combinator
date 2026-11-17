export const ERROR_CODES = {
  E_FFMPEG_MISSING: "E_FFMPEG_MISSING",
  E_INPUT_CORRUPT: "E_INPUT_CORRUPT",
  E_INPUT_TOO_LONG: "E_INPUT_TOO_LONG",
  E_NO_VIDEO_STREAM: "E_NO_VIDEO_STREAM",
  E_SPEC_MISMATCH: "E_SPEC_MISMATCH",
  E_RENDER_FAILED: "E_RENDER_FAILED",
  E_VERIFY_FAILED: "E_VERIFY_FAILED",
  E_RENAME_LOCKED: "E_RENAME_LOCKED",
  E_DISK_FULL: "E_DISK_FULL",
  E_TIMEOUT: "E_TIMEOUT",
  E_JOB_RUNNING: "E_JOB_RUNNING",
  E_PATH_INVALID: "E_PATH_INVALID",
  E_LIMIT_EXCEEDED: "E_LIMIT_EXCEEDED",
  E_UPLOAD_TOO_LARGE: "E_UPLOAD_TOO_LARGE",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_FFMPEG_MISSING: "FFmpeg atau FFprobe tidak ditemukan di folder bin/.",
  E_INPUT_CORRUPT: "File tidak bisa dibaca atau format video rusak.",
  E_INPUT_TOO_LONG: "Durasi video melebihi batas yang diizinkan (maksimal 120 detik).",
  E_NO_VIDEO_STREAM: "File tidak memiliki stream video yang valid.",
  E_SPEC_MISMATCH: "Klip video tidak sesuai dengan spesifikasi kanonik produk.",
  E_RENDER_FAILED: "Proses penggabungan FFmpeg gagal dieksekusi.",
  E_VERIFY_FAILED: "Hasil render video gagal dalam pengujian verifikasi ffprobe.",
  E_RENAME_LOCKED: "File sedang dipakai aplikasi lain saat proses finalisasi.",
  E_DISK_FULL: "Ruang penyimpanan disk tidak mencukupi untuk render.",
  E_TIMEOUT: "Proses render melebihi batas waktu (timeout 120 detik).",
  E_JOB_RUNNING: "Masih ada proses render lain yang sedang berjalan untuk produk ini.",
  E_PATH_INVALID: "Nama folder atau file tidak valid atau melanggar aturan sistem.",
  E_LIMIT_EXCEEDED: "Jumlah kombinasi melebihi batas aman (maksimal 2.000 video).",
  E_UPLOAD_TOO_LARGE: "Ukuran file melebihi batas upload (maksimal 1 GB).",
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: unknown
  ) {
    super(message || ERROR_MESSAGES[code]);
    this.name = "AppError";
  }
}
