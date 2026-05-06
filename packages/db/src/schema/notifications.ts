/**
 * Sprint 6 · S6.6 — notifications table.
 *
 * Per-user, per-company notification surface. The data layer; UI bell,
 * WS push, and BullMQ Slack daily summary cron are wired in follow-ups.
 */

import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

// `user.id` is text (Better-Auth schema), not uuid — see auth.ts.
// notifications.user_id therefore must also be text to match the FK.

/**
 * Closed set; mirrored by the CHECK constraint on `notifications.kind` in
 * migration 0100. Add new values via migration + this list together.
 */
export const NOTIFICATION_KINDS = [
  "approval_needed",
  "insight_critical",
  "workflow_completed",
  "integration_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Closed set for the polymorphic ref. Mirrored by the CHECK constraint on
 * `notifications.ref_kind` in migration 0100.
 */
export const NOTIFICATION_REF_KINDS = [
  "approval",
  "insight",
  "workflow_run",
  "integration",
] as const;
export type NotificationRefKind = (typeof NOTIFICATION_REF_KINDS)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /**
     * Notification kind — closed-set enum. Backstopped by CHECK constraint.
     */
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /**
     * Polymorphic ref to the source object. ref_kind picks the table;
     * ref_id is text so it can hold a uuid OR a structured composite id
     * (e.g. "workflow:run:abc123") if a downstream consumer wants
     * composite refs. Both columns nullable; CHECK constraint enforces
     * "both null or both set" — see migration 0100.
     */
    refKind: text("ref_kind").$type<NotificationRefKind | null>(),
    refId: text("ref_id"),
    /** null = unread; the unread-count badge query filters on this. */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Top-bar dropdown query: list this user's notifs newest-first. */
    userCreatedIdx: index("idx_notifications_user_created").on(
      table.userId,
      table.createdAt,
    ),
    /** Hot path: unread count badge. Partial — only carries unread rows. */
    userUnreadIdx: index("idx_notifications_user_unread").on(table.userId),
    /** Tenant-scoped admin view ("show all approval_needed in this company"). */
    companyKindCreatedIdx: index("idx_notifications_company_kind_created").on(
      table.companyId,
      table.kind,
      table.createdAt,
    ),
    /** Reverse lookup: "did we already notify about approval=abc?" */
    refIdx: index("idx_notifications_ref").on(table.refKind, table.refId),
  }),
);
