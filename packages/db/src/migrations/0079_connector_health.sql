-- 2026-05-05 — Connector health columns on composio_connections (S2.7)
--
-- Adds four sync-health columns + two CHECK constraints to track per-connector
-- freshness for the dashboard freshness indicators. All four columns are
-- additive with safe defaults (no full table rewrite on PG 11+ for nullable +
-- non-volatile defaults), meaning this runs safely on a live populated table
-- without backfill.
--
-- Single ALTER TABLE: all column adds + CHECK constraints in one statement
-- so we take ACCESS EXCLUSIVE exactly once instead of 4–6 times during the
-- Fly release_command — minimizes contention on the live composio_connections
-- table while migrations run pre-traffic-shift.
--
--   last_sync_at          — timestamptz NULL          — when data was last fetched (NULL = never)
--   last_sync_status      — text NOT NULL DEFAULT 'never' — ok|fail|partial|syncing|never
--   last_error            — text NULL                  — freeform error from last failure
--   consecutive_failures  — int  NOT NULL DEFAULT 0   — reset on success, +1 on fail
--
-- Why last_sync_status is NOT NULL (not nullable):
--   Council 2026-05-05 BLOCK fix. A nullable enum-shaped column leaks NULL
--   as an out-of-band 6th state on every existing live row, breaking dashboard
--   filters, retry logic, and freshness pills that pattern-match on the 5
--   advertised values (ok|fail|partial|syncing|never). Defaulting all
--   pre-existing rows to 'never' is correct — they have not synced.
--
-- CHECK constraints catch caller drift / typos at the DB layer regardless of
-- whether the writer goes through Drizzle, raw SQL, or a future migration.
-- Drizzle's $type<ConnectorSyncStatus>() is erased at runtime.
--
-- Rollback:
--   ALTER TABLE "composio_connections"
--     DROP CONSTRAINT IF EXISTS "composio_connections_last_sync_status_check",
--     DROP CONSTRAINT IF EXISTS "composio_connections_consecutive_failures_check",
--     DROP COLUMN IF EXISTS "last_sync_at",
--     DROP COLUMN IF EXISTS "last_sync_status",
--     DROP COLUMN IF EXISTS "last_error",
--     DROP COLUMN IF EXISTS "consecutive_failures";

ALTER TABLE "composio_connections"
  ADD COLUMN "last_sync_at" timestamptz,
  ADD COLUMN "last_sync_status" text NOT NULL DEFAULT 'never',
  ADD COLUMN "last_error" text,
  ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "composio_connections_last_sync_status_check"
    CHECK ("last_sync_status" IN ('ok','fail','partial','syncing','never')),
  ADD CONSTRAINT "composio_connections_consecutive_failures_check"
    CHECK ("consecutive_failures" >= 0);
