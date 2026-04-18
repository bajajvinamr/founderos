import { pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * FounderOS company-level business metrics.
 *
 * Stored in companies.metrics (JSONB) so the Dashboard Pulse widget can render
 * real financial signal (MRR/ARR/pipeline/burn/runway) without adding a column
 * per metric. All cents values are integers.
 */
export type CompanyMetrics = {
  stage?: string;                    // e.g. "Pre-seed", "Series Seed"
  tagline?: string;                  // 1-line positioning
  fundingRaisedCents?: number;       // total raised across rounds
  mrrCents?: number;
  arrCents?: number;
  gmvMonthlyCents?: number;          // for marketplaces
  pipelineCents?: number;
  pipelineCount?: number;
  customersSigned?: number;          // signed/paid accounts
  monthlyBurnCents?: number;
  runwayMonths?: number;
  keyAccounts?: string[];            // logo row
  nextMilestoneLabel?: string;       // e.g. "Series A Q4"
  mauCount?: number;                 // monthly active users
  deltas?: Record<string, { dir: "up" | "down" | "flat"; text: string }>;
};

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(true),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    brandColor: text("brand_color"),
    metrics: jsonb("metrics").$type<CompanyMetrics>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);
