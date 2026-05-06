-- 2026-05-06 — Content attribution engine (S4.3)
--
-- Adds attributionUtm column to content_drafts for tracking UTM parameters.
-- This field is auto-generated at publish time with format:
--   utm_source=founderos&utm_campaign=<draftId>&utm_medium=<format>
--
-- The tracking link (/c/:trackingId) uses draftId as the trackingId, logs a
-- click event, and redirects to publishedToUrl. Attribution aggregation queries
-- against the events table to compute clicks, signups, and revenue per draft.
--
-- Journal idx: 87

ALTER TABLE "content_drafts"
  ADD COLUMN "attribution_utm" text;
--> statement-breakpoint
