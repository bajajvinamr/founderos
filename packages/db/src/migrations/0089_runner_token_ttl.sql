-- Council 2026-05-05 W0.3 BLOCK fix — runner_tokens TTL + rotation + device fingerprint
--
-- Problem: runner_tokens had no expires_at. A lost laptop = permanent backdoor
-- with no way to bound the blast radius without a full revocation tour.
-- Audit posture also required device fingerprinting + a rotation chain so we
-- can correlate a compromised token to the device + force-rotate cleanly.
--
-- Backward compat: expires_at is NULLABLE and existing rows keep working —
-- they retain indefinite life until manually revoked. The application-layer
-- middleware enforces expiry only when the column is non-NULL. New tokens
-- issued via the dashboard / CLI default to a 90-day TTL (set by the
-- issuance route, not the schema default — the column default would force
-- indefinite-zero-day legacy rows to suddenly expire on backfill).
--
-- Single ALTER TABLE statement (per vinamr-invariants.md: "ALTER TABLE takes
-- ACCESS EXCLUSIVE lock per statement; combine into one multi-clause ALTER
-- to acquire the lock once and release immediately"). Critical on a hot
-- runner_tokens table where the runner polls every 5s under load.

ALTER TABLE "runner_tokens"
  ADD COLUMN "expires_at" timestamp with time zone,
  ADD COLUMN "rotated_from_token_id" uuid,
  ADD COLUMN "device_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_rotated_from_token_id_fk"
  FOREIGN KEY ("rotated_from_token_id") REFERENCES "runner_tokens"("id") ON DELETE set null;
--> statement-breakpoint
-- Index supports the dashboard "tokens nearing expiry" query AND the
-- middleware's expired-token rejection check. Partial-index on non-null
-- so legacy indefinite tokens don't bloat the btree.
CREATE INDEX "runner_tokens_expires_at_idx" ON "runner_tokens" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint
-- Index supports the rotation-chain audit query: "show me every token that
-- descended from this lost laptop's first issued token".
CREATE INDEX "runner_tokens_rotated_from_idx" ON "runner_tokens" ("rotated_from_token_id")
  WHERE "rotated_from_token_id" IS NOT NULL;
