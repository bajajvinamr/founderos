-- 2026-05-06 — Magic-link tokens (S6.7)
--
-- Short-lived single-use tokens used by the mobile daily brief flow:
--   1. Founder gets an email link "View today's brief" — token signs them
--      in to a read-only /brief view, expires in 24h, consumed on first
--      successful auth.
--   2. Each top-3 action in the email has an "Approve" link with its own
--      token (purpose=approve_action) bound to a specific approval row.
--
-- Security model (per vinamr-invariants on runner-token pattern):
--   - sha256 hex of plaintext stored in token_hash; plaintext NEVER stored
--   - plaintext is returned exactly once at issuance time (via the
--     service's `issue()` return value); UI/email is the only consumer
--   - constant-time compare on lookup (timingSafeEqual)
--   - single-use via consumed_at — once set, the token cannot re-auth
--     (we keep the row instead of DELETE for audit-trail forensics)
--   - 24h expiry by spec; service enforces ttlMinutes <= 1440
--
-- Schema notes:
--   - purpose: closed-set CHECK ('view_brief'|'approve_action') — same
--     vinamr-invariant CHECK-as-enum-backstop pattern
--   - target_ref_kind/target_ref_id: nullable polymorphic ref. Required
--     when purpose='approve_action' (points at the approval id). Pair
--     invariant CHECK enforces "both null or both set" — same shape as
--     notifications.ref_kind/ref_id.
--   - user_id is text to match Better-Auth user.id type
--
-- Indexes:
--   - unique on token_hash — the auth lookup. UNIQUE prevents re-issue
--     collision and serves as the only path to a row (defensive: never
--     enumerate by id alone).
--   - partial index on (expires_at) where consumed_at IS NULL — feeds
--     the cleanup cron query "find expired but unconsumed".
--   - composite (user_id, created_at DESC) — "show me recent magic links
--     issued to this user" for any future audit UX.
--
-- Lock semantics: CREATE TABLE on new empty table; no contention.
-- Idempotency: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--
-- Rollback: drop the table (CHECKs and indexes go with it).
--   DROP TABLE IF EXISTS "magic_link_tokens";

CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "purpose" text NOT NULL,
  "target_ref_kind" text,
  "target_ref_id" text,
  "consumed_at" timestamptz,
  "consumed_by_ip" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "magic_link_tokens_purpose_check"
    CHECK ("purpose" IN ('view_brief', 'approve_action')),
  CONSTRAINT "magic_link_tokens_ref_pair_check"
    CHECK (("target_ref_kind" IS NULL) = ("target_ref_id" IS NULL)),
  CONSTRAINT "magic_link_tokens_approve_requires_ref_check"
    CHECK ("purpose" <> 'approve_action' OR "target_ref_kind" IS NOT NULL)
);

-- Cleanup cron query: "find expired but unconsumed tokens" — partial
-- index keeps it small (most tokens are consumed within 24h or quickly
-- expire and get purged).
CREATE INDEX IF NOT EXISTS "idx_magic_link_tokens_unconsumed_expires"
  ON "magic_link_tokens" ("expires_at")
  WHERE "consumed_at" IS NULL;

-- Audit: "show me recent magic links issued to this user" — composite for
-- any future audit UX over per-user token history.
CREATE INDEX IF NOT EXISTS "idx_magic_link_tokens_user_created"
  ON "magic_link_tokens" ("user_id", "created_at" DESC);
