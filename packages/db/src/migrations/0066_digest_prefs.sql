-- Migration: 0066_digest_prefs
-- Adds per-user-per-company daily digest email preferences to
-- company_memberships. Defaults: digest ON, 08:00 user-local time, UTC tz.
-- `digest_last_sent_at` is used as an idempotency key so the digest job only
-- delivers one email per user per local day.

ALTER TABLE "company_memberships"
  ADD COLUMN IF NOT EXISTS "digest_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "company_memberships"
  ADD COLUMN IF NOT EXISTS "digest_hour_local" integer NOT NULL DEFAULT 8;
--> statement-breakpoint
ALTER TABLE "company_memberships"
  ADD COLUMN IF NOT EXISTS "digest_timezone" text NOT NULL DEFAULT 'UTC';
--> statement-breakpoint
ALTER TABLE "company_memberships"
  ADD COLUMN IF NOT EXISTS "digest_last_sent_at" timestamp with time zone;
