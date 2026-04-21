import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyMemory = pgTable(
  "company_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'weekly_summary' | 'experiment_outcome' | 'founder_note' | 'milestone'
    title: text("title").notNull(),
    body: text("body").notNull(),
    topic: text("topic"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    pinned: boolean("pinned").notNull().default(false),
    source: text("source").notNull(), // 'auto' | 'manual'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("idx_company_memory_company_occurred").on(table.companyId, table.occurredAt),
    pinnedIdx: index("idx_company_memory_pinned").on(table.companyId, table.pinned),
  }),
);
