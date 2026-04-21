import { z } from "zod";

export const memoryKindSchema = z.enum([
  "weekly_summary",
  "experiment_outcome",
  "founder_note",
  "milestone",
]);

export const memorySourceSchema = z.enum(["auto", "manual"]);

export const createCompanyMemorySchema = z.object({
  kind: memoryKindSchema.optional().default("founder_note"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  topic: z.string().max(100).nullable().optional(),
  occurredAt: z.coerce.date().optional(),
  pinned: z.boolean().optional().default(false),
});

export const updateCompanyMemorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  topic: z.string().max(100).nullable().optional(),
  pinned: z.boolean().optional(),
});

export const generateWeeklySummarySchema = z.object({
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
});

export type CreateCompanyMemory = z.infer<typeof createCompanyMemorySchema>;
export type UpdateCompanyMemory = z.infer<typeof updateCompanyMemorySchema>;
export type GenerateWeeklySummary = z.infer<typeof generateWeeklySummarySchema>;
