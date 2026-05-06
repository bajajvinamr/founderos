-- 2026-05-06 — Content drafts schema (S4.2)
--
-- Creates the content_drafts table that stores multi-format generated content
-- linked to a content_brief. One brief fans out into up to 6 drafts (one per
-- format: linkedin, x-thread, newsletter, reel, landing, ad).
--
-- Tenant isolation (TC-3 composite FK pattern):
--   content_briefs already has UNIQUE(id, company_id) from 0086_content_briefs.sql.
--   content_drafts denormalises company_id alongside brief_id and adds a
--   composite FK referencing BOTH columns. This ensures a draft cannot
--   reference a brief in a different tenant by forging brief_id alone.
--
-- Re-generation: latest-wins.
--   The service UPSERTs on the UNIQUE(brief_id, format) constraint.
--   Old payload is overwritten; no append-only row fan-out.
--
-- CHECK constraints:
--   format: 'linkedin' | 'x-thread' | 'newsletter' | 'reel' | 'landing' | 'ad'
--   status: 'drafted' | 'edited' | 'approved' | 'published' | 'discarded'
--   DB-level CHECK is the backstop for raw-SQL writes that bypass Zod.
--
-- Locking:
--   CREATE TABLE takes its own ACCESS EXCLUSIVE lock.
--   All post-create constraints are batched into a single ALTER TABLE to
--   acquire the lock once (per vinamr-invariants Postgres entry 2026-05-05).
--
-- Rollback:
--   ALTER TABLE "content_drafts" DROP CONSTRAINT IF EXISTS "content_drafts_brief_id_company_id_fk";
--   ALTER TABLE "content_drafts" DROP CONSTRAINT IF EXISTS "content_drafts_format_check";
--   ALTER TABLE "content_drafts" DROP CONSTRAINT IF EXISTS "content_drafts_status_check";
--   DROP INDEX IF EXISTS "content_drafts_brief_id_format_uq";
--   DROP INDEX IF EXISTS "content_drafts_brief_id_idx";
--   DROP INDEX IF EXISTS "content_drafts_company_status_idx";
--   DROP TABLE IF EXISTS "content_drafts";
--
-- Journal idx: 85

--------------------------------------------------------------------------
-- Phase 1: Create content_drafts table
--------------------------------------------------------------------------

CREATE TABLE "content_drafts" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"           uuid NOT NULL
                         REFERENCES "companies"("id") ON DELETE CASCADE,
  "brief_id"             uuid NOT NULL
                         REFERENCES "content_briefs"("id") ON DELETE CASCADE,
  "format"               text NOT NULL,
  "payload"              jsonb NOT NULL DEFAULT '{}',
  "status"               text NOT NULL DEFAULT 'drafted',
  "published_at"         timestamptz,
  "published_to_url"     text,
  "generated_by_run_id"  uuid,
  "generation_error"     text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 2: CHECK constraints + composite FK on content_drafts
--   Combined into one ALTER TABLE to hold ACCESS EXCLUSIVE once.
--------------------------------------------------------------------------

ALTER TABLE "content_drafts"
  ADD CONSTRAINT "content_drafts_format_check"
    CHECK ("format" IN (
      'linkedin',
      'x-thread',
      'newsletter',
      'reel',
      'landing',
      'ad'
    )),
  ADD CONSTRAINT "content_drafts_status_check"
    CHECK ("status" IN (
      'drafted',
      'edited',
      'approved',
      'published',
      'discarded'
    )),
  -- TC-3 composite FK: ensures draft.company_id == brief.company_id at the DB layer.
  -- content_briefs(id, company_id) UNIQUE was added in 0086_content_briefs.sql.
  ADD CONSTRAINT "content_drafts_brief_id_company_id_fk"
    FOREIGN KEY ("brief_id", "company_id")
    REFERENCES "content_briefs" ("id", "company_id")
    ON DELETE CASCADE;
--> statement-breakpoint

--------------------------------------------------------------------------
-- Phase 3: Indexes on content_drafts
--------------------------------------------------------------------------

-- One draft per format per brief — the upsert conflict target.
CREATE UNIQUE INDEX "content_drafts_brief_id_format_uq"
  ON "content_drafts" ("brief_id", "format");
--> statement-breakpoint

CREATE INDEX "content_drafts_brief_id_idx"
  ON "content_drafts" ("brief_id");
--> statement-breakpoint

CREATE INDEX "content_drafts_company_status_idx"
  ON "content_drafts" ("company_id", "status");
