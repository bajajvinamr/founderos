/**
 * insights — department-agent surfaced insights (S3.1)
 *
 * Insights are the unit of value the CoS / Growth / Content / CRM / Finance
 * agents emit. Each row is an actionable observation a founder can either act
 * on, dismiss, or let expire. The schema is intentionally generic so all five
 * department agents share one table — UI filters by `department` and `kind`
 * rather than fanning out across per-agent tables.
 *
 * Enum-shaped text columns (department, kind, status):
 *   We use `text` + DB-level CHECK constraints (in the migration) rather than
 *   pgEnum. CHECK is the runtime backstop for TypeScript union types — TS
 *   types erase at compile time, so any caller that bypasses the typed insert
 *   path (raw SQL, future migrations, agents that hand-craft inserts) would
 *   otherwise slip arbitrary strings in. Adding a new enum value is a
 *   one-line ALTER + journal entry vs. a pgEnum's ALTER TYPE dance.
 *
 * confidence:
 *   real (single-precision float) constrained 0..1 inclusive at the SQL layer.
 *   Agents must produce a calibrated score; the API rejects out-of-range
 *   values both at the Zod boundary and the DB CHECK.
 *
 * status lifecycle:
 *   open → acted_on (founder shipped the suggestion)
 *   open → dismissed (founder rejected; cannot reopen — see PATCH route)
 *   open → expired (set by future cron when expiresAt < now())
 *   The "no reopening from dismissed" rule lives in the API, not the DB —
 *   founders may want to override via direct SQL during incident response.
 *
 * FK: ON DELETE CASCADE — insights are tightly coupled to the company they
 * describe; if the company is deleted, surfacing stale insights is worse than
 * losing them. Diverges from `events` (RESTRICT) because events are billing/
 * audit data; insights are recommendation surface that's regenerable.
 *
 * Index `insights_company_kind_idx` (company_id, kind, created_at DESC):
 *   The dominant query pattern is "give me the latest 20 kpi_anomaly insights
 *   for this company." A composite index on (company_id, kind) with the
 *   created_at DESC suffix lets PG do an index-only forward scan for the
 *   common case without a separate sort step.
 */

import {
  pgTable,
  uuid,
  text,
  real,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const INSIGHT_DEPARTMENTS = [
  "chief-of-staff",
  "growth",
  "content",
  "crm",
  "finance",
] as const;

export type InsightDepartment = (typeof INSIGHT_DEPARTMENTS)[number];

export const INSIGHT_KINDS = [
  "kpi_anomaly",
  "opportunity",
  "blocker",
  "experiment_suggestion",
  "channel_recommendation",
  "attribution",
] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const INSIGHT_STATUSES = [
  "open",
  "acted_on",
  "dismissed",
  "expired",
] as const;

export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const insights = pgTable(
  "insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    department: text("department").$type<InsightDepartment>().notNull(),
    kind: text("kind").$type<InsightKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    confidence: real("confidence").notNull(),
    recommendation: text("recommendation"),
    evidence: jsonb("evidence").notNull(),
    status: text("status").$type<InsightStatus>().notNull().default("open"),
    outcomeNote: text("outcome_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byCompanyKind: index("insights_company_kind_idx").on(
      t.companyId,
      t.kind,
      t.createdAt.desc(),
    ),
  }),
);

export type Insight = typeof insights.$inferSelect;
export type InsightInsert = typeof insights.$inferInsert;
