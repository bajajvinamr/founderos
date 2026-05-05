/**
 * daily_briefs — LLM-generated daily founder brief (S3.3).
 *
 * One brief per (companyId, forDate). The CoS agent runs each morning at the
 * workspace's local 7am, aggregates yesterday's signal (KPI snapshots, open
 * insights, pending approvals, top opportunities, stalled workflows), and asks
 * Claude for a structured DailyBrief JSON. The result is persisted into
 * `payload` (jsonb) and rendered in `/brief` + emailed (when delivery wired up).
 *
 * Idempotency: the unique index on (companyId, forDate) means a re-run for
 * the same date returns the existing row without a second LLM call. This is
 * the same pattern as weekly_wraps' (companyId, weekEndingAt) idx — a Friday
 * 5pm cron tick that races with a manual "generate-now" click resolves to
 * "first writer wins"; the loser re-reads the winning row.
 *
 * payload shape (typed via DailyBriefPayload below):
 *   - headline:        terse founder-mode 1-liner
 *   - kpiMovements[]:  up to 5 metric deltas with from/to/delta/commentary
 *   - anomalies[]:     up to 3 spotted anomalies linked to insights rows
 *   - blockers[]:      up to 3 active blockers + suggested resolution
 *   - opportunities[]: up to 3 high-confidence opportunities + impact
 *   - topThreeActions[]: exactly 3 founder actions (each may link an approvalId)
 *
 * The schema validates this shape at the Zod boundary on write AND on read —
 * a malformed jsonb (e.g. older payload version) throws at parse time so the
 * UI never has to defensively pattern-match against unknown shapes.
 *
 * emailSentAt nullable timestamp:
 *   The cron stamps this when the brief is dispatched via Resend. Keeps the
 *   delivery state on the brief itself (no separate "deliveries" table) and
 *   gates idempotent re-sends.
 *
 * FK: ON DELETE CASCADE — briefs are recommendation surface tied to a
 * company; if the company is removed, the briefs go with it. (Same rationale
 * as insights/experiments; contrast events.RESTRICT.)
 *
 * Indexed primarily by the unique (companyId, forDate) — list-by-company
 * queries piggyback off it (the index is a covering prefix for the common
 * "give me the latest 30 briefs for company X" scan, ordered DESC at the
 * route layer).
 */

import {
  pgTable,
  uuid,
  date,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// ── Payload type definitions ─────────────────────────────────────────────────
// Kept here (rather than in a separate types file) so the schema, migration,
// service, and UI all agree on one source of truth for the wire shape.

export type DailyBriefKpiMovement = {
  metric: string;
  from: string;
  to: string;
  delta: string;
  commentary: string;
};

export type DailyBriefAnomaly = {
  title: string;
  insightId: string;
};

export type DailyBriefBlocker = {
  title: string;
  resolutionAction: string;
};

export type DailyBriefOpportunity = {
  title: string;
  expectedImpact: string;
  insightId: string;
};

export type DailyBriefTopAction = {
  action: string;
  rationale: string;
  approvalId?: string;
};

export type DailyBriefPayload = {
  headline: string;
  kpiMovements: DailyBriefKpiMovement[];
  anomalies: DailyBriefAnomaly[];
  blockers: DailyBriefBlocker[];
  opportunities: DailyBriefOpportunity[];
  topThreeActions: DailyBriefTopAction[];
};

export const dailyBriefs = pgTable(
  "daily_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    forDate: date("for_date").notNull(),
    payload: jsonb("payload").$type<DailyBriefPayload>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  },
  (t) => ({
    uniquePerDate: uniqueIndex("daily_briefs_company_date_idx").on(
      t.companyId,
      t.forDate,
    ),
  }),
);

export type DailyBrief = typeof dailyBriefs.$inferSelect;
export type DailyBriefInsert = typeof dailyBriefs.$inferInsert;
