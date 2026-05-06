import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { workflowRuns } from "./workflows.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * S6.2 — when this approval is gating a workflow_run, this column
     * links them so the UI can render "see full plan" against the
     * workflow's step tree. Nullable for generic approvals (hire,
     * budget override, plugin install) that have no workflow context.
     * ON DELETE SET NULL preserves the approval audit trail when a
     * workflow_run is deleted.
     */
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
    workflowRunIdx: index("approvals_workflow_run_id_idx")
      .on(table.workflowRunId)
      .where(sql`${table.workflowRunId} IS NOT NULL`),
  }),
);
