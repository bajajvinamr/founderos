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
  /** Channel ID to post Weekly Wrap into; empty = disabled. */
  weeklyWrapSlackChannelId?: string;
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
    /**
     * Per-tenant postal address rendered into customer-email footer for
     * CAN-SPAM/GDPR compliance (#197). Set via Settings UI. NULL means the
     * founder hasn't configured it yet; the email-wrapper fails-closed at
     * send time when NULL — better to refuse to send than to ship a legally
     * non-compliant email on the founder's behalf.
     */
    physicalAddress: text("physical_address"),
    /**
     * Per-tenant reply-to / support email for customer-facing communications.
     * NULL falls back to the From address. Used by the email-wrapper to render
     * "Questions? Reply to this email" or "support@<company>" in the footer.
     */
    supportEmail: text("support_email"),
    metrics: jsonb("metrics").$type<CompanyMetrics>().notNull().default({}),
    /**
     * `true` for rows inserted by `seed-demo*.ts`. Buyer-trust hazard backstop:
     * lets ops queries filter / count / purge demo data unambiguously, and
     * gives the UI / billing / analytics layers a single column to exclude
     * synthetic rows from real metrics. NEVER mutate this for real customer
     * rows. Default `false`. See P0 audit finding #5 (2026-05-09).
     */
    isDemo: boolean("is_demo").notNull().default(false),
    /**
     * Per-company persona / dogfood metadata.
     *
     * Mira Labs dogfood sets `metadata.persona = "mira-labs-dogfood"` to
     * mark the company as the FounderOS dogfood persona. Used by:
     *   - seed scripts: idempotency check (abort if persona row exists)
     *   - DB trigger: reject is_demo = true flips on persona rows
     *   - analytics: exclude persona rows from real-founder metrics
     *
     * NULL for all existing and normal rows. Nullable to avoid a table
     * rewrite on the ALTER TABLE ADD COLUMN migration.
     *
     * Added: migration 0109_mira_labs_is_demo_guard (TD-1, 2026-05-13).
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);
