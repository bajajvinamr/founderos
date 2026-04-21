-- Migration: 0063_instance_invites
-- Creates the instance-scoped invites table used by the instance admin
-- invite flow. Each row represents a pending or consumed invite sent to
-- a specific email address. A partial unique index guarantees at most
-- one pending invite per email.

CREATE TABLE IF NOT EXISTS "instance_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'instance_member',
  "token" text NOT NULL UNIQUE,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instance_invites_email_pending_idx"
  ON "instance_invites" ("email")
  WHERE "consumed_at" IS NULL;
