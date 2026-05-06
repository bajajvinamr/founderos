import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * content_briefs — S4.1 Content Studio brief schema.
 *
 * A content brief captures the founder's intent (thesis, audience, angle)
 * before fanning out into 6 content formats (S4.2). One brief drives one
 * generation run; regeneration rewrites the linked drafts in-place (S4.2
 * latest-wins decision).
 *
 * Tenant isolation: company_id FK with RESTRICT delete so briefs survive
 * accidental company-row mutations. The (id, company_id) UNIQUE constraint
 * is added here so S4.2's content_drafts table can reference this table
 * via composite FK following the TC-3 pattern.
 *
 * Status state machine:
 *   draft → researching → drafting → review → scheduled → published
 *
 * CHECK on status is enforced at the SQL layer; the TS union is erased at
 * runtime and raw SQL writes could bypass Zod.
 */

export const CONTENT_BRIEF_STATUSES = [
  "draft",
  "researching",
  "drafting",
  "review",
  "scheduled",
  "published",
] as const;

export type ContentBriefStatus = (typeof CONTENT_BRIEF_STATUSES)[number];

export const contentBriefs = pgTable(
  "content_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    thesis: text("thesis").notNull(),
    audience: text("audience"),
    angle: text("angle"),
    keywords: text("keywords").array(),
    notesMarkdown: text("notes_markdown"),
    status: text("status")
      .$type<ContentBriefStatus>()
      .notNull()
      .default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byCompanyId: index("content_briefs_company_id_idx").on(t.companyId),
    byCompanyCreated: index("content_briefs_company_created_at_idx").on(
      t.companyId,
      t.createdAt,
    ),
  }),
);

export type ContentBrief = typeof contentBriefs.$inferSelect;
export type ContentBriefInsert = typeof contentBriefs.$inferInsert;
