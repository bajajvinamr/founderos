import { z } from "zod";

export const memoryKindSchema = z.enum([
  "weekly_summary",
  "experiment_outcome",
  "founder_note",
  "milestone",
]);

export const memorySourceSchema = z.enum(["auto", "manual"]);

/**
 * S6.4 — agent-recall semantic category. Mirrors the CHECK constraint on
 * `company_memory.category` and the `COMPANY_MEMORY_CATEGORIES` const in the
 * db schema. Add new values via migration + this enum + the schema const,
 * all together.
 */
export const memoryCategorySchema = z.enum([
  "decision",
  "pattern",
  "context",
  "outcome",
]);

export const createCompanyMemorySchema = z.object({
  kind: memoryKindSchema.optional().default("founder_note"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  topic: z.string().max(100).nullable().optional(),
  occurredAt: z.coerce.date().optional(),
  pinned: z.boolean().optional().default(false),
  // S6.4 — optional semantic category for agent recall.
  category: memoryCategorySchema.nullable().optional(),
  // S6.4 — optional TTL. NULL/omitted = no expiry.
  expiresAt: z.coerce.date().nullable().optional(),
});

export const updateCompanyMemorySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  topic: z.string().max(100).nullable().optional(),
  pinned: z.boolean().optional(),
  // S6.4 — recategorize a memory entry post-hoc.
  category: memoryCategorySchema.nullable().optional(),
  // S6.4 — extend or remove TTL.
  expiresAt: z.coerce.date().nullable().optional(),
});

export const generateWeeklySummarySchema = z.object({
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
});

export type CreateCompanyMemory = z.infer<typeof createCompanyMemorySchema>;
export type UpdateCompanyMemory = z.infer<typeof updateCompanyMemorySchema>;
export type GenerateWeeklySummary = z.infer<typeof generateWeeklySummarySchema>;
