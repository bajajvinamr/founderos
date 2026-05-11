/**
 * P3 Wave 2 · W2.5 — inbox_state table.
 *
 * Per-user, polymorphic Inbox state for any item the founder can act on:
 *   - approval
 *   - issue
 *   - decision
 *   - mention
 *
 * One row per (user, entity_type, entity_id). Drives the Inbox UI's
 * read/unread, snooze, archive, and QuickApprove 10s-undo flow.
 *
 * See migration `0108_inbox_state.sql` for FK + CHECK + UNIQUE +
 * partial-index details. The CHECK constraints on `entity_type` and
 * `state` are the runtime backstop — TS unions erase at compile time,
 * raw SQL inserts and migrations bypass them.
 */

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * Closed set; mirrored by the CHECK constraint on
 * `inbox_state.entity_type` in migration 0108. Add new values via
 * migration + this list together.
 */
export const INBOX_STATE_ENTITY_TYPES = [
  "approval",
  "issue",
  "decision",
  "mention",
] as const;
export type InboxStateEntityType = (typeof INBOX_STATE_ENTITY_TYPES)[number];

/**
 * Closed set; mirrored by the CHECK constraint on
 * `inbox_state.state` in migration 0108. Add new values via
 * migration + this list together.
 */
export const INBOX_STATES = [
  "unread",
  "read",
  "snoozed",
  "archived",
] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export const inboxState = pgTable(
  "inbox_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * user.id is text (Better-Auth schema) — same as
     * notifications.user_id and magic_link_tokens.user_id.
     */
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /**
     * Closed-set polymorphic discriminator. Backstopped by CHECK.
     */
    entityType: text("entity_type").$type<InboxStateEntityType>().notNull(),
    /**
     * Every referenceable entity (approval, issue, decision, mention)
     * has a uuid primary key today, so entity_id is uuid (not text).
     */
    entityId: uuid("entity_id").notNull(),
    /**
     * Current lifecycle state. Source of truth — the *_at timestamps
     * are evidence + the snooze-expiry query input, not the state.
     */
    state: text("state").$type<InboxState>().notNull().default("unread"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /**
     * Hot Inbox query: "show this user's unread + snoozed rows."
     * Partial WHERE lives in the migration SQL; Drizzle's DSL doesn't
     * carry the predicate here but the runtime index is partial.
     */
    userStateIdx: index("idx_inbox_state_user_state").on(
      table.userId,
      table.state,
    ),
    /**
     * Upsert target — every (user, entity_type, entity_id) pair has
     * at most one row. Idempotent snooze/archive/mark-read upserts
     * key against this. Per OQ-4 (frontend-plan 00-overview).
     */
    userEntityUnique: uniqueIndex("inbox_state_user_entity_unique").on(
      table.userId,
      table.entityType,
      table.entityId,
    ),
  }),
);

export type InboxStateRow = typeof inboxState.$inferSelect;
export type InboxStateInsert = typeof inboxState.$inferInsert;
