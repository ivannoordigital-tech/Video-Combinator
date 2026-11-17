import { z } from "zod";

export const OutputStatusSchema = z.enum(["DONE", "FAILED", "STALE", "ORPHAN", "CANCELLED"]);
export type OutputStatus = z.infer<typeof OutputStatusSchema>;

export const OutputItemSchema = z.object({
  key: z.string().length(8),
  hook: z.string(),
  body: z.string(),
  cta: z.string(),
  status: OutputStatusSchema,
  durationSeconds: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  assetFingerprints: z.object({
    hook: z.string(),
    body: z.string(),
    cta: z.string(),
  }),
  specHash: z.string(),
  verified: z.boolean().default(false),
  error: z.string().nullable().default(null),
});
export type OutputItem = z.infer<typeof OutputItemSchema>;

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  product: z.string(),
  specHash: z.string(),
  updatedAt: z.string(),
  tool: z.object({
    app: z.string(),
    ffmpeg: z.string(),
  }),
  outputs: z.record(z.string(), OutputItemSchema).default({}),
});
export type Manifest = z.infer<typeof ManifestSchema>;
