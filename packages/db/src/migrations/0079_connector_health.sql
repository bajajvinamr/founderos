-- 2026-05-05 — Connector health columns on composio_connections (S2.7)
--
-- Adds four nullable/defaulted columns to track per-connector sync health so
-- the dashboard can render freshness indicators without a separate table.
-- All four are additive (no NOT NULL without a default, or with a safe default)
-- meaning this runs safely on a live populated table with no backfill needed.
--
--   last_sync_at          — timestamptz null  — when data was last fetched
--   last_sync_status      — text null         — ok|fail|partial|syncing|never
--   last_error            — text null         — freeform error from last failure
--   consecutive_failures  — int not null default 0
--
-- Rollback:
--   ALTER TABLE "composio_connections" DROP COLUMN IF EXISTS "last_sync_at";
--   ALTER TABLE "composio_connections" DROP COLUMN IF EXISTS "last_sync_status";
--   ALTER TABLE "composio_connections" DROP COLUMN IF EXISTS "last_error";
--   ALTER TABLE "composio_connections" DROP COLUMN IF EXISTS "consecutive_failures";

ALTER TABLE "composio_connections" ADD COLUMN "last_sync_at" timestamptz;
ALTER TABLE "composio_connections" ADD COLUMN "last_sync_status" text;
ALTER TABLE "composio_connections" ADD COLUMN "last_error" text;
ALTER TABLE "composio_connections" ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0;
