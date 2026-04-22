import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * A single customer/user conversation (pasted transcript today, audio/upload
 * tomorrow). The LLM extracts bullet-sized, durable lessons into
 * extracted_insights which the founder can promote row-by-row into
 * company_memory.
 */
export type ExtractedInsight = {
  title: string;
  content: string;
  confidence: number; // 0..1
  source_quote: string;
};

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // Participants: free-text labels (e.g. ["Founder", "Parent A", "Teacher"]).
    // Nullable at the DB level so legacy inserts without a list still work.
    participants: text("participants").array(),
    // 'transcript_paste' | 'upload' | 'slack_import' (future).
    sourceKind: text("source_kind").notNull(),
    transcript: text("transcript").notNull(),
    // 'pending' | 'complete' | 'failed'. Defaults to pending so the row is
    // visible the instant the founder submits; the extractor flips it later.
    extractionStatus: text("extraction_status").notNull().default("pending"),
    extractedInsights: jsonb("extracted_insights").$type<ExtractedInsight[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("idx_conversations_company_created").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
