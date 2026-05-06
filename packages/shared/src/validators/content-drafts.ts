import { z } from "zod";

/**
 * Content draft format and status constants (S4.2).
 *
 * Must stay in sync with:
 *   - CONTENT_DRAFT_FORMATS / CONTENT_DRAFT_STATUSES in packages/db/src/schema/content_drafts.ts
 *   - CHECK constraints in 0088_content_drafts.sql
 */
export const CONTENT_DRAFT_FORMATS = [
  "linkedin",
  "x-thread",
  "newsletter",
  "reel",
  "landing",
  "ad",
] as const;

export type ContentDraftFormatValue = (typeof CONTENT_DRAFT_FORMATS)[number];

export const CONTENT_DRAFT_STATUSES = [
  "drafted",
  "edited",
  "approved",
  "published",
  "discarded",
] as const;

export type ContentDraftStatusValue = (typeof CONTENT_DRAFT_STATUSES)[number];

/**
 * POST /api/companies/:id/content-briefs/:briefId/generate
 *
 * Kicks off multi-format generation for the given brief. Body may optionally
 * carry a workflowId for audit trail association (S4.5 integration point).
 */
export const generateContentSchema = z.object({
  /**
   * Optional — pass when generation is triggered from a workflow lifecycle so
   * the activity log can be filtered by workflow.
   */
  workflowId: z.string().uuid().optional().nullable(),
});

export type GenerateContent = z.infer<typeof generateContentSchema>;

/**
 * GET /api/companies/:id/content-drafts/:draftId
 * No request body — query-param free for now.
 */

/**
 * PATCH /api/companies/:id/content-drafts/:draftId
 * Allows updating status + publishedToUrl.
 */
export const updateContentDraftSchema = z.object({
  status: z.enum(CONTENT_DRAFT_STATUSES).optional(),
  publishedToUrl: z.string().url().max(2000).optional().nullable(),
});

export type UpdateContentDraft = z.infer<typeof updateContentDraftSchema>;
