import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * composio_connections — per-user OAuth connection references into Composio.
 *
 * We do NOT store the OAuth tokens themselves. Composio's managed OAuth
 * hosts the consent flow and holds the credentials server-side; we only
 * keep the opaque connection id so we can target a specific entity when
 * executing a tool on behalf of a given FounderOS user.
 *
 * Tenancy:
 *   - `company_id` — FK → companies, cascaded on delete.
 *   - `user_id`    — FounderOS user id (board user), free-form text so it
 *                    survives auth provider swaps. Access checks happen at
 *                    the route layer via `requireCompanyAccess`.
 *
 * Uniqueness: (company_id, user_id, app_name) — one connection per (user, app)
 * inside a company. Reconnecting overwrites via UPSERT.
 */
export const composioConnections = pgTable(
  "composio_connections",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** e.g. "slack" | "hubspot" | "notion" | "linkedin" */
    appName: text("app_name").notNull(),
    /** Opaque Composio-side connection id. */
    composioConnectionId: text("composio_connection_id").notNull(),
    /** pending | active | failed | revoked */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyUserAppUnique: uniqueIndex(
      "composio_connections_company_user_app_unique",
    ).on(table.companyId, table.userId, table.appName),
    companyIdx: index("composio_connections_company_idx").on(table.companyId),
    userIdx: index("composio_connections_user_idx").on(table.userId),
  }),
);

export type ComposioConnection = typeof composioConnections.$inferSelect;
export type ComposioConnectionInsert = typeof composioConnections.$inferInsert;
