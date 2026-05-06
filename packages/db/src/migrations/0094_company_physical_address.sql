-- 0094_company_physical_address.sql — S4.8 prerequisite #197 layer 1
--
-- Adds the per-tenant physical postal address required by CAN-SPAM § 7704(a)(5)
-- and GDPR Recital 47 (legitimate-interest disclosure). Every customer-facing
-- email shipped via the wrapper (services/transports/email-wrapper.ts) renders
-- this address in the footer; without it, the wrapper fails-closed at send time
-- (no email is sent if the founder hasn't filled it in — the alternative is
-- shipping legally non-compliant emails on the founder's behalf).
--
-- Nullable because:
--   - existing tenants have no address yet (founder must fill it in via Settings)
--   - the wrapper enforces presence at send time, NOT at row-create time
--   - keeping NOT NULL on a column without a sensible default would make the
--     migration block every existing row's insert path during the rollout
--
-- support_email is a separate column for the "reply-to" / unsubscribe-by-reply
-- contact, distinct from the From address. CAN-SPAM allows physical mail OR
-- functional email reply for opt-out — having both gives founders flexibility.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "physical_address" text,
  ADD COLUMN IF NOT EXISTS "support_email" text;

-- Audit-friendly comment for ops queries.
COMMENT ON COLUMN "companies"."physical_address" IS
  'Per-tenant postal address rendered into the customer-email footer for CAN-SPAM/GDPR compliance. Set via Settings UI. NULL means the founder hasn''t configured it yet — the email-wrapper fails-closed at send time when NULL.';
COMMENT ON COLUMN "companies"."support_email" IS
  'Per-tenant reply-to / support email for customer-facing communications. NULL falls back to the From address.';
