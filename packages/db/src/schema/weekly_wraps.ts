import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Wave 18B — Weekly Wrap auto-delivery.
 *
 * A single generated wrap per (companyId, weekEndingAt). The Friday 17:00-local
 * cron inserts one row, then the delivery pipeline stamps `delivered_to_slack_at`
 * / `delivered_to_email_at` as each channel succeeds. The UNIQUE constraint on
 * (companyId, weekEndingAt) makes re-runs safe.
 */
export type WeeklyWrapHighlight = {
  type: "issue_shipped" | "decision_approved" | "activity" | "blocker";
  title: string;
  url?: string | null;
};

export type WeeklyWrapMetrics = {
  issuesShipped?: number;
  decisionsApproved?: number;
  activityCount?: number;
  openBlockers?: number;
  agentSpendCents?: number;
  [key: string]: unknown;
};

export const weeklyWraps = pgTable(
  "weekly_wraps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Friday 23:59:59 in the company's primary timezone, stored as UTC. */
    weekEndingAt: timestamp("week_ending_at", { withTimezone: true }).notNull(),
    narrative: text("narrative").notNull(),
    highlights: jsonb("highlights")
      .$type<WeeklyWrapHighlight[]>()
      .notNull()
      .default([]),
    metrics: jsonb("metrics")
      .$type<WeeklyWrapMetrics>()
      .notNull()
      .default({}),
    deliveredToSlackAt: timestamp("delivered_to_slack_at", { withTimezone: true }),
    deliveredToEmailAt: timestamp("delivered_to_email_at", { withTimezone: true }),
    slackChannelId: text("slack_channel_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWeekIdx: index("idx_weekly_wraps_company_week").on(
      table.companyId,
      table.weekEndingAt,
    ),
    companyWeekUniqueIdx: uniqueIndex("weekly_wraps_company_week_unique_idx").on(
      table.companyId,
      table.weekEndingAt,
    ),
  }),
);
