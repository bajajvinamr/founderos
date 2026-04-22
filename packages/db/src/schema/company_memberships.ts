import { pgTable, uuid, text, timestamp, uniqueIndex, index, boolean, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    status: text("status").notNull().default("active"),
    membershipRole: text("membership_role"),
    // ---- Wave 17A: daily digest email preferences (per user per company) ----
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    digestHourLocal: integer("digest_hour_local").notNull().default(8),
    digestTimezone: text("digest_timezone").notNull().default("UTC"),
    digestLastSentAt: timestamp("digest_last_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPrincipalUniqueIdx: uniqueIndex("company_memberships_company_principal_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    principalStatusIdx: index("company_memberships_principal_status_idx").on(
      table.principalType,
      table.principalId,
      table.status,
    ),
    companyStatusIdx: index("company_memberships_company_status_idx").on(table.companyId, table.status),
  }),
);
