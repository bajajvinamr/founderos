-- 2026-05-05 — Activity log workflow lineage placeholder (S1.8)
--
-- Adds two nullable columns to activity_log to support workflow-level
-- audit lineage in S6. Both columns are additive (NULL default, no
-- NOT NULL constraint) so this is safe to run on a populated table
-- without locking or backfill.
--
-- workflow_id: text (not uuid) because the workflows table does not
-- exist until S4.5. The FK will be added and the column narrowed to
-- uuid in a future migration when the workflows table lands.
--
-- lineage_refs: jsonb to hold { insightIds?, approvalIds?, eventIds? }
-- once populated by S6.3. NULL in S1 for all existing and new rows.
--
-- Rollback:
--   ALTER TABLE "activity_log" DROP COLUMN IF EXISTS "workflow_id";
--   ALTER TABLE "activity_log" DROP COLUMN IF EXISTS "lineage_refs";

ALTER TABLE "activity_log" ADD COLUMN "workflow_id" text;
ALTER TABLE "activity_log" ADD COLUMN "lineage_refs" jsonb;
