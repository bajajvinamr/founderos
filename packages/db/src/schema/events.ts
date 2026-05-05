import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const EVENT_SOURCES = [
  "stripe",
  "posthog",
  "linkedin",
  "notion",
  "slack",
  "hubspot",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").$type<EventSource>().notNull(),
    entityType: text("entity_type").notNull(),
    eventName: text("event_name").notNull(),
    sourceEventId: text("source_event_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    sourceDedup: unique("events_source_dedup_unique")
      .on(t.companyId, t.source, t.sourceEventId)
      .nullsNotDistinct(),
    byCompanyTs: index("events_company_occurred_at_idx").on(
      t.companyId,
      t.occurredAt,
    ),
    bySourceTs: index("events_source_occurred_at_idx").on(
      t.companyId,
      t.source,
      t.occurredAt,
    ),
  }),
);

export type Event = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
