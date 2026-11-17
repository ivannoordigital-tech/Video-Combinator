import { z } from "zod";
import { createHash } from "node:crypto";

export const ProductSlugRegex = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const ProductVideoConfigSchema = z.object({
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fps: z.number().int().positive().default(30),
  fit: z.enum(["pad", "crop"]).default("pad"),
  codec: z.literal("h264").default("h264"),
  profile: z.enum(["baseline", "main", "high"]).default("high"),
  level: z.string().default("4.1"),
  pixFmt: z.literal("yuv420p").default("yuv420p"),
  crf: z.number().int().min(0).max(51).default(18),
  preset: z.string().default("veryfast"),
  gop: z.number().int().positive().default(60),
});

export const ProductAudioConfigSchema = z.object({
  codec: z.literal("aac").default("aac"),
  sampleRate: z.number().int().positive().default(48000),
  channels: z.number().int().positive().default(2),
  bitrate: z.string().default("192k"),
  loudnorm: z.boolean().default(true),
  targetLufs: z.number().default(-16),
});

export const ProductRenderConfigSchema = z.object({
  mode: z.enum(["fast", "quality"]).default("fast"),
  workers: z.number().int().min(1).max(6).default(3),
  faststart: z.boolean().default(true),
});

export const ProductNamingConfigSchema = z.object({
  includeHash: z.boolean().default(true),
  maxSlugLength: z.number().int().min(8).max(64).default(28),
});

export const ProductLimitsConfigSchema = z.object({
  maxCombinations: z.number().int().positive().default(2000),
  warnCombinations: z.number().int().positive().default(500),
  maxAssetSizeMb: z.number().int().positive().default(1024),
  minClipSeconds: z.number().positive().default(0.5),
  maxClipSeconds: z.number().positive().default(120),
});

export const ProductConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  slug: z.string().regex(ProductSlugRegex, "Slug harus a-z, 0-9, atau tanda hubung, 2-32 karakter"),
  displayName: z.string().min(1).max(64),
  createdAt: z.string(),
  video: ProductVideoConfigSchema.default({}),
  audio: ProductAudioConfigSchema.default({}),
  render: ProductRenderConfigSchema.default({}),
  naming: ProductNamingConfigSchema.default({}),
  limits: ProductLimitsConfigSchema.default({}),
});

export type ProductConfig = z.infer<typeof ProductConfigSchema>;
export type ProductVideoConfig = z.infer<typeof ProductVideoConfigSchema>;
export type ProductAudioConfig = z.infer<typeof ProductAudioConfigSchema>;

/**
 * Menghasilkan hash 12 karakter dari parameter video dan audio kanonik.
 * Jika parameter diubah, specHash berubah dan aset yang ada ditandai STALE.
 */
export function computeSpecHash(video: ProductVideoConfig, audio: ProductAudioConfig): string {
  const payload = JSON.stringify({ video, audio });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
