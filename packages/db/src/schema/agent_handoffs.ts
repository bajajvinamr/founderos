import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const agentHandoffs = pgTable(
  "agent_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    fromIssueId: uuid("from_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    toIssueId: uuid("to_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    request: text("request").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>().default({}).notNull(),
    // pending | accepted | in_progress | completed | rejected | failed
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    result: text("result"),
    resultRef: text("result_ref"),
  },
  (table) => ({
    toAgentStatusIdx: index("agent_handoffs_to_agent_status_idx").on(
      table.companyId,
      table.toAgentId,
      table.status,
    ),
    fromAgentIdx: index("agent_handoffs_from_agent_idx").on(
      table.fromAgentId,
      table.status,
    ),
    fromIssueIdx: index("agent_handoffs_from_issue_idx").on(table.fromIssueId),
  }),
);

export type AgentHandoff = typeof agentHandoffs.$inferSelect;
export type AgentHandoffInsert = typeof agentHandoffs.$inferInsert;
