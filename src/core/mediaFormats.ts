/**
 * Ekstensi file audio yang diterima di folder backsounds.
 * `.mp4` ikut didukung karena banyak file audio (mis. hasil unduhan)
 * dikemas dalam kontainer MP4; ingest hanya mengambil stream audionya.
 */
export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".mp4"]);
