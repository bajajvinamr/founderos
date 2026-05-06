-- Migration 0093: customer_email_suppressions
-- Council 2026-05-06 S4.8 prerequisite #4 (suppression model)
--
-- Adds customer_email_suppressions table for CAN-SPAM / GDPR compliance:
-- per-tenant per-recipient per-topic suppression with mandatory pre-send checks
-- in customer-facing workflow templates (onboarding-emails, activation-nudge,
-- upsell, churn-rescue).
--
-- Topic 'all' is the master suppression — pre-send checks short-circuit when
-- (company_id, contact_email, 'all') row exists. Per-topic suppressions let
-- users opt out of churn-rescue without losing onboarding sequences.
--
-- The CHECK constraints on topic and reason are the runtime backstop for the
-- TypeScript union types — TS unions erase at compile time, raw SQL inserts
-- and migrations can slip arbitrary values otherwise (vinamr-invariants
-- Postgres rule).
--
-- contact_email lowercase CHECK enforces normalization at the DB layer so the
-- (company_id, contact_email, topic) UNIQUE constraint deduplicates correctly
-- regardless of caller-side casing bugs.

CREATE TABLE customer_email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_email text NOT NULL,
  topic text NOT NULL,
  reason text NOT NULL,
  source_workflow_run_id uuid,
  source_message_id text,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT customer_email_suppressions_topic_check
    CHECK (topic IN ('all', 'onboarding', 'activation_nudge', 'upsell', 'churn_rescue', 'product_update')),
  CONSTRAINT customer_email_suppressions_reason_check
    CHECK (reason IN ('user_unsubscribe', 'bounce_hard', 'spam_report', 'admin_action')),
  CONSTRAINT customer_email_suppressions_email_lowercase
    CHECK (contact_email = lower(contact_email)),
  CONSTRAINT customer_email_suppressions_topic_unique
    UNIQUE (company_id, contact_email, topic)
);

CREATE INDEX customer_email_suppressions_company_email_idx
  ON customer_email_suppressions (company_id, contact_email);
