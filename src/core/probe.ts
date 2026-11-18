import { FFmpegResolver } from "./ffmpeg.js";
import { AppError } from "../schemas/errors.js";

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | string;
  codec_name?: string;
  profile?: string;
  level?: number | string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_aspect_ratio?: string;
  sample_rate?: string | number;
  channels?: number;
  duration?: string | number;
  side_data_list?: Array<{
    side_data_type?: string;
    rotation?: number;
  }>;
}

export interface ProbeFormat {
  filename: string;
  nb_streams: number;
  format_name: string;
  format_long_name?: string;
  duration?: string | number;
  size?: string | number;
  bit_rate?: string | number;
}

export interface ProbeResult {
  format: ProbeFormat;
  streams: ProbeStream[];
  videoStream: ProbeStream | null;
  audioStream: ProbeStream | null;
  durationSeconds: number;
  rotation: number;
  fps: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Mengubah string frame rate ffprobe ("30/1", "30000/1001") menjadi angka.
 * Mengembalikan 0 jika rasio tidak valid agar pemanggil tidak menerima NaN.
 */
export function parseFrameRate(rate: unknown): number {
  if (typeof rate !== "string" || !rate.trim()) return 0;
  const [numRaw, denRaw] = rate.split("/");
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  const value = num / den;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

export class VideoProbe {
  public static async probeFile(filePath: string): Promise<ProbeResult> {
    try {
      const { stdout } = await FFmpegResolver.executeFfprobe([
        "-v", "error",
        "-show_entries", "format=duration,size,bit_rate,nb_streams,format_name:stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_aspect_ratio,sample_rate,channels,duration:stream_side_data=rotation,side_data_type",
        "-of", "json",
        filePath,
      ]);

      const data = JSON.parse(stdout);
      const streams: ProbeStream[] = data.streams || [];
      const format: ProbeFormat = data.format || { filename: filePath, nb_streams: streams.length, format_name: "mp4" };

      const videoStream = streams.find((s) => s.codec_type === "video") || null;
      const audioStream = streams.find((s) => s.codec_type === "audio") || null;

      if (audioStream && audioStream.sample_rate) {
        audioStream.sample_rate = Number(audioStream.sample_rate);
      }

      if (!videoStream) {
        throw new AppError("E_NO_VIDEO_STREAM", `File tidak memiliki stream video: ${filePath}`);
      }

      // Hitung rotasi dari side_data_list
      let rotation = 0;
      if (videoStream.side_data_list) {
        for (const side of videoStream.side_data_list) {
          if (typeof side.rotation === "number") {
            rotation = side.rotation;
            break;
          }
        }
      }

      // Hitung fps dari avg_frame_rate misal "30/1" (fallback r_frame_rate)
      let fps = parseFrameRate(videoStream.avg_frame_rate);
      if (fps === 0) {
        fps = parseFrameRate(videoStream.r_frame_rate);
      }

      // Durasi: format container lebih akurat, lalu stream video/audio sebagai fallback.
      // Nilai non-finite (NaN/Infinity) diganti 0 agar perbandingan downstream aman.
      let durationCandidate = toFiniteNumber(format.duration);
      if (durationCandidate === null) durationCandidate = toFiniteNumber(videoStream.duration);
      if (durationCandidate === null) durationCandidate = toFiniteNumber(audioStream?.duration);
      const durationSeconds = durationCandidate !== null && durationCandidate > 0 ? durationCandidate : 0;

      return {
        format,
        streams,
        videoStream,
        audioStream,
        durationSeconds,
        rotation,
        fps,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("E_INPUT_CORRUPT", `Gagal melakukan probe file: ${filePath}`, err);
    }
  }

  /**
   * Menghasilkan signature spesifikasi string unik untuk memvalidasi kompatibilitas stream-copy concat.
   * Contoh: "h264|high|4.1|1080x1920|yuv420p|30/1|1:1|aac|48000|2"
   */
  public static specSignature(probe: ProbeResult): string {
    const v = probe.videoStream;
    const a = probe.audioStream;

    if (!v) return "invalid_no_video";

    const vCodec = v.codec_name?.toLowerCase() || "unknown";
    const vProfile = v.profile?.toLowerCase().replace(/\s+/g, "") || "unknown";
    const vLevel = String(v.level || "unknown");
    const vRes = `${v.width || 0}x${v.height || 0}`;
    const vPixFmt = v.pix_fmt?.toLowerCase() || "unknown";
    const vFps = v.avg_frame_rate || "unknown";
    const vSar = v.sample_aspect_ratio || "1:1";

    const aCodec = a?.codec_name?.toLowerCase() || "none";
    const aRate = String(a?.sample_rate || 0);
    const aChannels = String(a?.channels || 0);

    return `${vCodec}|${vProfile}|${vLevel}|${vRes}|${vPixFmt}|${vFps}|${vSar}|${aCodec}|${aRate}|${aChannels}`;
  }
}
