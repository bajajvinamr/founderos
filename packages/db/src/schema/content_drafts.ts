import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { contentBriefs } from "./content_briefs.js";
import { companies } from "./companies.js";

/**
 * content_drafts — S4.2 Multi-format content generator output.
 *
 * One brief fans out into up to 6 drafts (one per format). Each draft has its
 * own status so the founder can publish LinkedIn but discard X independently.
 *
 * Tenant isolation (TC-3 composite FK pattern):
 *   content_briefs has UNIQUE(id, company_id) — see 0086_content_briefs.sql.
 *   content_drafts.company_id is denormalised alongside brief_id and the FK
 *   references BOTH columns, ensuring a draft cannot reference a brief from
 *   a different tenant even if brief_id is forged.
 *
 * Re-generation strategy: latest-wins.
 *   On re-run, the service UPSERTs on (brief_id, format) — old payload is
 *   overwritten, status resets to 'drafted', generatedByRunId is bumped.
 *   No append-only rows; the unique constraint enforces one-per-format.
 *
 * Status state machine:
 *   drafted → edited → approved → published | discarded
 *
 * CHECK constraints on format and status provide DB-level safety for raw SQL
 * writes that bypass Zod. Any new format/status value MUST update BOTH this
 * file AND the CHECK expression in 0088_content_drafts.sql.
 */

export const CONTENT_DRAFT_FORMATS = [
  "linkedin",
  "x-thread",
  "newsletter",
  "reel",
  "landing",
  "ad",
] as const;

export type ContentDraftFormat = (typeof CONTENT_DRAFT_FORMATS)[number];

export const CONTENT_DRAFT_STATUSES = [
  "drafted",
  "edited",
  "approved",
  "published",
  "discarded",
] as const;

export type ContentDraftStatus = (typeof CONTENT_DRAFT_STATUSES)[number];

/**
 * Per-format payload types — mirror the GeneratedContent type produced by
 * the content-generator service. Stored as jsonb.
 */
export type LinkedInPayload = {
  body: string;
  hashtagSuggestions: string[];
  estimatedReadTime: number;
};

export type XThreadPayload = {
  tweets: string[];
  commentary: string;
};

export type NewsletterPayload = {
  subject: string;
  body: string;
};

export type ReelScriptPayload = {
  hook: string;
  valueBeats: string[];
  cta: string;
  runtime: string;
};

export type LandingCopyPayload = {
  headline: string;
  subheadline: string;
  bullets: string[];
  cta: string;
};

export type AdCreativePayload = {
  primaryText: string;
  headline: string;
  description: string;
};

export type ContentDraftPayload =
  | LinkedInPayload
  | XThreadPayload
  | NewsletterPayload
  | ReelScriptPayload
  | LandingCopyPayload
  | AdCreativePayload;

export const contentDrafts = pgTable(
  "content_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Denormalised company_id alongside brief_id so the composite FK
     * FOREIGN KEY (brief_id, company_id) REFERENCES content_briefs(id, company_id)
     * can enforce same-tenant ownership without a join.
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => contentBriefs.id, { onDelete: "cascade" }),
    format: text("format").$type<ContentDraftFormat>().notNull(),
    payload: jsonb("payload").$type<ContentDraftPayload>().notNull(),
    status: text("status")
      .$type<ContentDraftStatus>()
      .notNull()
      .default("drafted"),
    /** Populated on publish — when and where the content went live. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedToUrl: text("published_to_url"),
    /**
     * Opaque run-id that ties this draft to the specific generation invocation.
     * Bumped on every re-generation so the audit trail shows which run produced
     * the current payload.
     */
    generatedByRunId: uuid("generated_by_run_id"),
    /**
     * Non-null when generation failed for this format. The service records the
     * error message here and sets status='drafted' with a null payload. Caller
     * can surface this to the founder.
     *
     * NOTE: payload is still required (NOT NULL in DB) — on LLM failure the
     * service writes `{}` as a sentinel and the error is surfaced via this
     * column + the brief transitioning to 'drafting' (not 'review').
     */
    generationError: text("generation_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * One draft per format per brief — latest-wins upsert target.
     * The composite unique on (brief_id, format) is what the service
     * conflicts on during re-generation.
     */
    briefFormatUnique: uniqueIndex("content_drafts_brief_id_format_uq").on(
      t.briefId,
      t.format,
    ),
    byBriefId: index("content_drafts_brief_id_idx").on(t.briefId),
    byCompanyStatus: index("content_drafts_company_status_idx").on(
      t.companyId,
      t.status,
    ),
  }),
);

export type ContentDraft = typeof contentDrafts.$inferSelect;
export type ContentDraftInsert = typeof contentDrafts.$inferInsert;
