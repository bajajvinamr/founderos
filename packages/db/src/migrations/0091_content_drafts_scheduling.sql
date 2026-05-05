-- 2026-05-06 — Content drafts scheduling columns (S4.4)
--
-- Adds scheduled_for and error columns to content_drafts for supporting
-- automated publishing at scheduled times.
--
-- Columns:
--   scheduled_for: When this draft should be published (nullable, default NULL)
--   error: Publication error message, truncated to 500 chars (nullable)
--
-- Rollback:
--   ALTER TABLE "content_drafts" DROP COLUMN IF EXISTS "scheduled_for";
--   ALTER TABLE "content_drafts" DROP COLUMN IF EXISTS "error";
--
-- Journal idx: 88

ALTER TABLE "content_drafts"
  ADD COLUMN "scheduled_for" timestamptz,
  ADD COLUMN "error" text;
--> statement-breakpoint

-- Index for querying due drafts efficiently in the publish-tick job
CREATE INDEX "content_drafts_scheduled_status_idx"
  ON "content_drafts" ("scheduled_for", "status")
  WHERE "scheduled_for" IS NOT NULL;
