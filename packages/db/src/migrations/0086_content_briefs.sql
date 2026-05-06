-- 2026-05-05 — Content briefs schema (S4.1)
--
-- Creates the content_briefs table that backs Content Studio.
-- A brief captures the founder's intent (title, thesis, audience, angle,
-- keywords) and drives the multi-format generator (S4.2).
--
-- Tenant isolation:
--   company_id → companies.id ON DELETE RESTRICT (briefs survive accidental
--   company-row mutations; hard-delete flow must explicitly wipe briefs first).
--
--   The (id, company_id) UNIQUE constraint follows the TC-3 pattern so
--   child tables (content_drafts — S4.2) can add composite FKs that prove
--   same-tenant ownership without a join.
--
-- CHECK constraint on status:
--   draft | researching | drafting | review | scheduled | published
--   DB-level CHECK is the backstop for raw-SQL writes that bypass Zod.
--
-- Indexes:
--   content_briefs_company_id_idx        — list-all queries
--   content_briefs_company_created_at_idx — paginated newest-first list
--
-- Locking: single ALTER TABLE statement per table to take ACCESS EXCLUSIVE
--   once and release immediately (see vinamr-invariants Postgres entry).
--   The CREATE TABLE itself takes its own lock; only the post-create
--   constraints are batched.
--
-- Journal idx: 83

CREATE TABLE "content_briefs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"      uuid NOT NULL
                    REFERENCES "companies"("id") ON DELETE RESTRICT,
  "title"           text NOT NULL,
  "thesis"          text NOT NULL,
  "audience"        text,
  "angle"           text,
  "keywords"        text[],
  "notes_markdown"  text,
  "status"          text NOT NULL DEFAULT 'draft',
  "scheduled_for"   timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- TC-3 pattern: (id, company_id) UNIQUE so S4.2 content_drafts can
-- reference via composite FK to prove same-tenant ownership.
ALTER TABLE "content_briefs"
  ADD CONSTRAINT "content_briefs_id_company_id_uq" UNIQUE ("id", "company_id"),
  ADD CONSTRAINT "content_briefs_status_check"
    CHECK ("status" IN ('draft','researching','drafting','review','scheduled','published'));
--> statement-breakpoint

CREATE INDEX "content_briefs_company_id_idx"
  ON "content_briefs" ("company_id");
--> statement-breakpoint

CREATE INDEX "content_briefs_company_created_at_idx"
  ON "content_briefs" ("company_id", "created_at");
