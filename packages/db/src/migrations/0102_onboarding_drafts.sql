-- 2026-05-06 — Onboarding draft persistence (S6.8)
--
-- Save-and-resume backbone for the founder onboarding wizard. The UI
-- already has 8 steps + draft state in useState (FounderOnboardingWizard);
-- this migration adds the server-side persistence so the draft survives
-- page reloads, browser closes, and cross-device resume.
--
-- Schema notes:
--   - userId is text (Better-Auth) — same FK pattern as runner_tokens,
--     magic_link_tokens, notifications.
--   - currentStep: smallint with CHECK 1..8. The wizard's TOTAL_STEPS is
--     8 (FounderOnboardingWizard.tsx:42). If the wizard adds steps the
--     migration must change too.
--   - draftJson: opaque jsonb. The wizard owns the schema; the server
--     just stores and returns it. Validators in @founderos/shared keep
--     the API surface honest, but they're shape-tolerant — any keys not
--     known to the server are persisted as-is for forward compat.
--   - completedAt: nullable. NULL = draft in-progress; set = wizard done.
--     Once completed, the row stays for audit (e.g. "did this user
--     finish onboarding? when?") — same single-use+forensic pattern as
--     magic_link_tokens.consumed_at.
--   - UNIQUE INDEX on user_id WHERE completed_at IS NULL — one
--     in-progress draft per user; finishing the wizard frees that user
--     to start over (rare, but supported, e.g. self-serve repeat
--     onboarding to a second workspace).
--
-- Lock semantics: CREATE TABLE on new empty table; no contention.
-- Idempotency: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
--
-- Rollback:
--   DROP TABLE IF EXISTS "onboarding_drafts";

CREATE TABLE IF NOT EXISTS "onboarding_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "current_step" smallint NOT NULL DEFAULT 1,
  "draft_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "onboarding_drafts_step_check"
    CHECK ("current_step" >= 1 AND "current_step" <= 8)
);

-- One in-progress draft per user. Once completed, the user can start a
-- new draft (the partial unique allows multiple completed rows + at
-- most one in-progress).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_onboarding_drafts_user_active"
  ON "onboarding_drafts" ("user_id")
  WHERE "completed_at" IS NULL;

-- Per-user history: "show me this user's onboarding completions" — covers
-- the support/audit case where we want to know if a re-onboarding
-- happened.
CREATE INDEX IF NOT EXISTS "idx_onboarding_drafts_user_created"
  ON "onboarding_drafts" ("user_id", "created_at" DESC);
