-- S5.6 — Marketing spend ledger (channel × period × amount)
--
-- Supports per-channel CAC + LTV/CAC calc. Joined upstream with S3.8
-- channel attribution to derive customers acquired per channel; joined
-- downstream with revenue events to compute per-channel LTV.
--
-- amount_cents >= 0 (positive-only in v1; refunds as separate
-- negative-amount adjustment rows is a v2 consideration).
-- period_end >= period_start.
-- channel is one of 8 enum values (CHECK at DB layer because TS unions
-- erase at compile time — vinamr-invariants pattern).

CREATE TABLE IF NOT EXISTS "marketing_spend" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text,
  CONSTRAINT "marketing_spend_amount_non_negative" CHECK ("amount_cents" >= 0),
  CONSTRAINT "marketing_spend_period_order" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "marketing_spend_channel_enum" CHECK (
    "channel" IN (
      'linkedin','paid_meta','paid_google','referral',
      'seo','partnerships','content','other'
    )
  )
);

CREATE INDEX IF NOT EXISTS "marketing_spend_company_channel_period_idx"
  ON "marketing_spend" ("company_id", "channel", "period_start");

CREATE INDEX IF NOT EXISTS "marketing_spend_company_period_idx"
  ON "marketing_spend" ("company_id", "period_start");
