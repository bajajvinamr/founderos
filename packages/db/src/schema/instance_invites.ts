import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Instance-scoped email invites. One invite per email address is "pending"
 * at any given time (enforced by a partial unique index on email WHERE
 * consumed_at IS NULL). When the invited user signs up, the post-signup
 * hook marks the invite consumed and creates the matching
 * `instance_user_roles` row, auto-promoting them to the right role.
 */
export const instanceInvites = pgTable(
  "instance_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: text("role").notNull().default("instance_member"),
    token: text("token").notNull().unique(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedBy: text("consumed_by"),
  },
  (table) => ({
    emailPendingIdx: uniqueIndex("instance_invites_email_pending_idx").on(table.email),
  }),
);
