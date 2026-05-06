import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * customer_email_suppressions — S4.8 prerequisite #196.
 *
 * Council 2026-05-06 finding #4 (BLOCK): customer-facing workflow templates
 * (onboarding-emails, activation-nudge, upsell, churn-rescue) had NO
 * suppression model — every send risked CAN-SPAM / GDPR violation.
 *
 * One row per (company_id, contact_email, topic). Topic 'all' is the master
 * switch — pre-send checks short-circuit when a (company, email, 'all') row
 * exists. Per-topic suppressions let users opt out of churn-rescue without
 * losing onboarding sequences.
 *
 * Pre-send invariant: every customer-facing workflow template MUST query
 * (company_id, contact_email, topic) AND (company_id, contact_email, 'all')
 * before send; presence of either row → skip the send + record the skip in
 * activity_log with reason `suppressed`.
 *
 * Layered scope (one commit per layer per LRP atomic-commit policy):
 *   #196 layer 1 (this commit): suppression fact table.
 *   #196 layer 2: unsubscribe token model + verifier service.
 *   #196 layer 3: pre-send check helper + integration into 4 templates.
 *   #196 layer 4: Resend webhook receiver auto-inserts on hard bounce + spam.
 */

export const SUPPRESSION_TOPICS = [
  "all",
  "onboarding",
  "activation_nudge",
  "upsell",
  "churn_rescue",
  "product_update",
] as const;

export type SuppressionTopic = (typeof SUPPRESSION_TOPICS)[number];

export const SUPPRESSION_REASONS = [
  "user_unsubscribe",
  "bounce_hard",
  "spam_report",
  "admin_action",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const customerEmailSuppressions = pgTable(
  "customer_email_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactEmail: text("contact_email").notNull(),
    topic: text("topic").$type<SuppressionTopic>().notNull(),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    sourceWorkflowRunId: uuid("source_workflow_run_id"),
    sourceMessageId: text("source_message_id"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    topicCheck: check(
      "customer_email_suppressions_topic_check",
      sql`${t.topic} IN ('all', 'onboarding', 'activation_nudge', 'upsell', 'churn_rescue', 'product_update')`,
    ),
    reasonCheck: check(
      "customer_email_suppressions_reason_check",
      sql`${t.reason} IN ('user_unsubscribe', 'bounce_hard', 'spam_report', 'admin_action')`,
    ),
    emailLowercase: check(
      "customer_email_suppressions_email_lowercase",
      sql`${t.contactEmail} = lower(${t.contactEmail})`,
    ),
    topicUnique: uniqueIndex("customer_email_suppressions_topic_unique").on(
      t.companyId,
      t.contactEmail,
      t.topic,
    ),
    companyEmailIdx: index("customer_email_suppressions_company_email_idx").on(
      t.companyId,
      t.contactEmail,
    ),
  }),
);

export type CustomerEmailSuppression = typeof customerEmailSuppressions.$inferSelect;
export type CustomerEmailSuppressionInsert = typeof customerEmailSuppressions.$inferInsert;
