import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const instanceUserRoles = pgTable(
  "instance_user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FK + ON DELETE CASCADE added 2026-05-04 (council finding):
    // pre-fix, deleting a user from "user" left an orphan role row that
    // blocked first-user-wins promotion forever. local-board principal is
    // seeded in ensureLocalTrustedBoardPrincipal so the FK is satisfied
    // in dev/local_trusted mode too.
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("instance_admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRoleUniqueIdx: uniqueIndex("instance_user_roles_user_role_unique_idx").on(table.userId, table.role),
    roleIdx: index("instance_user_roles_role_idx").on(table.role),
  }),
);
