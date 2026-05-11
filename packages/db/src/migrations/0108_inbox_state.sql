-- 2026-05-12 — Wave 2 W2.5 — inbox_state (per-user, polymorphic Inbox state)
--
-- Per-user state for any item that can show up in the founder's Inbox:
-- approvals, issues, decisions, mentions. One polymorphic table per OQ-3
-- (frontend-plan 00-overview), not three parallel state columns on each
-- source table. The Inbox UI (03-work-surfaces §A) joins entity rows to
-- this table to drive read/unread, snooze, archive, and the QuickApprove
-- 10s-undo flow.
--
-- Schema notes:
--   - user_id is text, NOT uuid — the canonical "user".id is text
--     (Better-Auth schema in packages/db/src/schema/auth.ts). The
--     frontend-plan §3.3 spec wrote `user_id UUID` but every existing
--     user_id FK in this repo (notifications, magic_link_tokens,
--     runner_tokens) is `text` to match the auth schema. Divergence
--     from the spec but a forced one to compile against the live FK.
--   - entity_id is uuid — every referenceable entity (approvals,
--     issues, decisions, mentions) has a uuid primary key today.
--   - entity_type is CHECK-constrained (per vinamr-invariants: TS
--     unions erase at compile time; the CHECK is the runtime backstop
--     for raw SQL inserts, migrations, and agents bypassing the typed
--     insert path). Same pattern as notifications.kind in 0100.
--   - state is CHECK-constrained likewise. Default 'unread' so a row
--     written by archive/snooze/mark-read pickup matches the
--     transition the caller intended; nothing relies on the default
--     other than belt-and-braces.
--   - snoozed_until, read_at, archived_at: kept as separate nullable
--     timestamps for forensic clarity ("when did this become read?")
--     and so a snoozed row can carry its expiry independent of the
--     state column. The state column is the source of truth; the
--     timestamps are evidence + the snooze-expiry query input.
--   - FK to "user"(id) ON DELETE CASCADE — when a user is deleted,
--     their inbox state disappears with them. Matches the
--     notifications + instance_user_roles structural pattern.
--   - UNIQUE(user_id, entity_type, entity_id) — every (user, entity)
--     pair has at most one state row. This is the upsert target for
--     snooze/archive/mark-read (per OQ-4: upsert-on-snooze idempotent).
--
-- Indexes:
--   - idx_inbox_state_user_state — partial on the hot Inbox query
--     ("show this user's unread + snoozed rows"). Partial WHERE
--     excludes 'read' and 'archived' so the index stays small as
--     the table grows.
--
-- Lock semantics: CREATE TABLE on a brand-new (empty) table takes
-- its own ACCESS EXCLUSIVE briefly; no contention. Index creation
-- in the same migration is fast on the empty table.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- Rollback:
--   DROP TABLE IF EXISTS "inbox_state";
--   (CHECK constraints + indexes drop with the table.)

CREATE TABLE IF NOT EXISTS "inbox_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'unread',
  "snoozed_until" timestamptz,
  "read_at" timestamptz,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "inbox_state_entity_type_check"
    CHECK ("entity_type" IN ('approval', 'issue', 'decision', 'mention')),
  CONSTRAINT "inbox_state_state_check"
    CHECK ("state" IN ('unread', 'read', 'snoozed', 'archived')),
  CONSTRAINT "inbox_state_user_entity_unique"
    UNIQUE ("user_id", "entity_type", "entity_id")
);

-- Hot Inbox query: "show this user's unread + snoozed rows."
-- Partial index — only carries rows that are actually in-tray, so
-- it stays bounded by the working-set size rather than total history.
CREATE INDEX IF NOT EXISTS "idx_inbox_state_user_state"
  ON "inbox_state" ("user_id", "state")
  WHERE "state" IN ('unread', 'snoozed');
