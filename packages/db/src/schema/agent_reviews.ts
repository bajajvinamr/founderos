import { pgTable, uuid, text, timestamp, integer, date, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentReviews = pgTable(
  "agent_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    monthOf: date("month_of").notNull(), // first day of the reviewed month
    shiftsRun: integer("shifts_run").notNull().default(0),
    issuesClosed: integer("issues_closed").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    blockedIncidents: integer("blocked_incidents").notNull().default(0),
    summaryMarkdown: text("summary_markdown").notNull(),
    recommendation: text("recommendation").notNull(), // 'keep' | 'rebrief' | 'let_go' | 'promote'
    rationale: text("rationale").notNull(),
    source: text("source").notNull().default("auto"), // 'auto' | 'manual'
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyMonthIdx: index("idx_agent_reviews_company_month").on(table.companyId, table.monthOf),
    agentMonthIdx: index("idx_agent_reviews_agent_month").on(table.agentId, table.monthOf),
    agentMonthUnique: unique("agent_reviews_agent_month_unique").on(table.agentId, table.monthOf),
  }),
);
