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

/**
 * events — canonical event ingestion table.
 *
 * Dedup contract: callers MUST provide a `dedupKey` for every event. When the
 * source has a natural ID (Stripe `evt_*`, PostHog event uuid), pass it
 * directly. When the source has no natural ID (Slack messages, custom
 * events), synthesize one — e.g. `${channel}:${ts}:${user}`. The DB-level
 * CHECK on `source` and the (company_id, source, dedup_key) UNIQUE constraint
 * together guarantee idempotent replay regardless of writer path. The CHECK
 * is enforced at the SQL layer because $type<EventSource>() is erased at
 * runtime.
 *
 * FK behavior: ON DELETE RESTRICT on company_id — events are audit/billing
 * data; a tenant hard-delete must explicitly handle event retention via a
 * soft-delete or archive flow on companies (out of scope for this table).
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    source: text("source").$type<EventSource>().notNull(),
    entityType: text("entity_type").notNull(),
    eventName: text("event_name").notNull(),
    dedupKey: text("dedup_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    sourceDedup: unique("events_dedup_unique").on(
      t.companyId,
      t.source,
      t.dedupKey,
    ),
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
