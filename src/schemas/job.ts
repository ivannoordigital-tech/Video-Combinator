import { z } from "zod";

export const JobStatusSchema = z.enum([
  "IDLE",
  "RUNNING",
  "DONE",
  "CANCELLED",
  "FAILED",
  "INTERRUPTED",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobScopeSchema = z.enum(["new", "stale", "all", "subset"]);
export type JobScope = z.infer<typeof JobScopeSchema>;

export const JobSchema = z.object({
  jobId: z.string(),
  product: z.string(),
  status: JobStatusSchema,
  scope: JobScopeSchema.default("new"),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  current: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  etaSeconds: z.number().nonnegative().default(0),
  cancelled: z.boolean().default(false),
});
export type Job = z.infer<typeof JobSchema>;
