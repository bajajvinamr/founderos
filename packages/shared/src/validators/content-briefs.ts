import { z } from "zod";

/**
 * Content brief status state machine (S4.1):
 *   draft → researching → drafting → review → scheduled → published
 *
 * These values must stay in sync with:
 *   - CONTENT_BRIEF_STATUSES in packages/db/src/schema/content_briefs.ts
 *   - CHECK constraint in 0086_content_briefs.sql
 */
export const CONTENT_BRIEF_ANGLES = [
  "pain-point",
  "contrarian",
  "how-to",
  "data-driven",
] as const;

export type ContentBriefAngle = (typeof CONTENT_BRIEF_ANGLES)[number];

export const CONTENT_BRIEF_STATUSES = [
  "draft",
  "researching",
  "drafting",
  "review",
  "scheduled",
  "published",
] as const;

export type ContentBriefStatusValue = (typeof CONTENT_BRIEF_STATUSES)[number];

/**
 * POST /api/companies/:id/content-briefs
 * Creates a new content brief.
 */
export const createContentBriefSchema = z.object({
  title: z.string().min(1).max(500),
  thesis: z.string().min(1).max(2_000),
  audience: z.string().max(500).optional().nullable(),
  angle: z.enum(CONTENT_BRIEF_ANGLES).optional().nullable(),
  keywords: z.array(z.string().max(100)).max(20).optional().nullable(),
  notesMarkdown: z.string().max(50_000).optional().nullable(),
  scheduledFor: z
    .union([z.string().datetime(), z.date(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return v;
      return v instanceof Date ? v : new Date(v);
    }),
});

export type CreateContentBrief = z.infer<typeof createContentBriefSchema>;

/**
 * PATCH /api/companies/:id/content-briefs/:briefId
 * Updates any mutable field on a brief; status can only be set via
 * POST .../transition to enforce the valid-transition check.
 */
export const updateContentBriefSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  thesis: z.string().min(1).max(2_000).optional(),
  audience: z.string().max(500).optional().nullable(),
  angle: z.enum(CONTENT_BRIEF_ANGLES).optional().nullable(),
  keywords: z.array(z.string().max(100)).max(20).optional().nullable(),
  notesMarkdown: z.string().max(50_000).optional().nullable(),
  scheduledFor: z
    .union([z.string().datetime(), z.date(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return v;
      return v instanceof Date ? v : new Date(v);
    }),
});

export type UpdateContentBrief = z.infer<typeof updateContentBriefSchema>;

/**
 * POST /api/companies/:id/content-briefs/:briefId/transition
 * Explicit status transition endpoint so the state machine is enforced in
 * one place rather than being a free-form PATCH field.
 */
export const transitionContentBriefSchema = z.object({
  status: z.enum(CONTENT_BRIEF_STATUSES),
});

export type TransitionContentBrief = z.infer<
  typeof transitionContentBriefSchema
>;

/**
 * GET /api/companies/:id/content-briefs query params
 */
export const listContentBriefsQuerySchema = z.object({
  status: z.enum(CONTENT_BRIEF_STATUSES).optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(100_000))
    .optional(),
});

export type ListContentBriefsQuery = z.infer<
  typeof listContentBriefsQuerySchema
>;
