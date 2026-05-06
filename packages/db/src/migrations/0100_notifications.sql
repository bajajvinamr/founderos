-- 2026-05-06 — Notifications (S6.6)
--
-- Per-user, per-company notifications surface for in-app bell + Slack
-- daily summary. The data layer ships in this migration; UI bell, WS push,
-- and BullMQ Slack cron are wired in follow-up tickets that consume this
-- table.
--
-- Schema notes:
--   - kind: closed-set enum enforced by CHECK (per vinamr-invariants — TS
--     unions erase at compile time, raw SQL inserts and migrations bypass
--     them; CHECK is the runtime backstop).
--   - refKind/refId polymorphic ref: refKind is a closed-set CHECK enum
--     ('approval'|'insight'|'workflow_run'|'integration'); refId is text
--     so it can hold a uuid OR a structured composite id (e.g.
--     "workflow:run:abc123" if a downstream consumer wants composite refs).
--     Both columns nullable — a notification doesn't have to point at a row.
--   - read_at: nullable timestamp; null = unread. Indexed via a partial
--     index on (user_id, read_at) WHERE read_at IS NULL, since the unread
--     count query is the hot path (top bar bell badge).
--   - companyId is for tenant scoping; userId is who sees it. ON DELETE
--     CASCADE on both — when the user or company goes away, their
--     notifications go too.
--
-- Lock semantics: CREATE TABLE acquires its own ACCESS EXCLUSIVE on the
-- new (empty) table, no contention. Indexes created in same migration are
-- fast since the table is empty.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--
-- Rollback:
--   DROP TABLE IF EXISTS "notifications";
--   (CHECK constraints + indexes drop with the table.)

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "ref_kind" text,
  "ref_id" text,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "notifications_kind_check"
    CHECK ("kind" IN (
      'approval_needed',
      'insight_critical',
      'workflow_completed',
      'integration_failed'
    )),
  CONSTRAINT "notifications_ref_kind_check"
    CHECK ("ref_kind" IS NULL OR "ref_kind" IN (
      'approval',
      'insight',
      'workflow_run',
      'integration'
    )),
  CONSTRAINT "notifications_ref_pair_check"
    -- Either both ref_kind and ref_id are set, or both are null.
    CHECK ((ref_kind IS NULL) = (ref_id IS NULL))
);

-- List notifications for a user, newest first — the top bar dropdown query.
CREATE INDEX IF NOT EXISTS "idx_notifications_user_created"
  ON "notifications" ("user_id", "created_at" DESC);

-- Hot path: unread count badge. Partial index — only carries unread rows.
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread"
  ON "notifications" ("user_id")
  WHERE "read_at" IS NULL;

-- Tenant-scoped admin views ("show me all approval_needed notifs in this
-- company") — composite index on (company_id, kind, created_at DESC).
CREATE INDEX IF NOT EXISTS "idx_notifications_company_kind_created"
  ON "notifications" ("company_id", "kind", "created_at" DESC);

-- Polymorphic ref reverse lookup ("did we already notify about
-- approval=abc?") — small partial index, only carries rows that have a ref.
CREATE INDEX IF NOT EXISTS "idx_notifications_ref"
  ON "notifications" ("ref_kind", "ref_id")
  WHERE "ref_kind" IS NOT NULL;
