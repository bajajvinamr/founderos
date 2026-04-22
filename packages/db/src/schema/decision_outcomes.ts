import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { companyMemory } from "./company_memory.js";

/**
 * decision_outcomes — post-decision outcome tracking.
 *
 * Closes the loop on approved decisions: ~14 days after `decidedAt`, a cron
 * inserts a `pending_followup` row, prompting the founder to record what
 * actually happened. The recorded outcome can then be promoted into
 * company_memory as a durable learning.
 *
 * Each approval has at most one decision_outcomes row (enforced at the service
 * layer — the cron checks for an existing row before inserting).
 */
export const decisionOutcomes = pgTable(
  "decision_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // 'pending_followup' | 'worked' | 'did_not_work' | 'unclear' | 'dropped'
    outcomeStatus: text("outcome_status").notNull(),
    promptedAt: timestamp("prompted_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    founderNote: text("founder_note"),
    // Free-form e.g. "MRR +15%", "closed 3 customers", "churn -2pp"
    metricDelta: text("metric_delta"),
    // If the outcome was promoted into company_memory, this links the row.
    memoryEntryId: uuid("memory_entry_id").references(() => companyMemory.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalIdx: index("idx_decision_outcomes_approval").on(table.approvalId),
    companyStatusIdx: index("idx_decision_outcomes_company_status").on(
      table.companyId,
      table.outcomeStatus,
    ),
  }),
);
