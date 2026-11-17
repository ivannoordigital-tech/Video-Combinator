import { z } from "zod";

export const AssetKindSchema = z.enum(["hook", "body", "cta"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetStatusSchema = z.enum(["READY", "ERROR", "PROCESSING"]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const AssetOriginSchema = z.enum(["scan", "upload"]);
export type AssetOrigin = z.infer<typeof AssetOriginSchema>;

export const AssetItemSchema = z.object({
  slug: z.string().min(1).max(32),
  enabled: z.boolean().default(true),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  origin: AssetOriginSchema.default("scan"),
  status: AssetStatusSchema.default("READY"),
  ingestedAt: z.string(),
  error: z.string().nullable().default(null),
});
export type AssetItem = z.infer<typeof AssetItemSchema>;

export const AssetsRegistrySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  specHash: z.string(),
  assets: z.object({
    hook: z.record(z.string(), AssetItemSchema).default({}),
    body: z.record(z.string(), AssetItemSchema).default({}),
    cta: z.record(z.string(), AssetItemSchema).default({}),
  }).default({ hook: {}, body: {}, cta: {} }),
});
export type AssetsRegistry = z.infer<typeof AssetsRegistrySchema>;
