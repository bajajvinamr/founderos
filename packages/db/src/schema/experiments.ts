import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const EXPERIMENT_DEPARTMENTS = [
  "growth",
  "chief-of-staff",
  "content",
  "crm",
  "finance",
] as const;

export const EXPERIMENT_STATUSES = [
  "proposed",
  "running",
  "completed",
  "abandoned",
] as const;

export const EXPERIMENT_CHANNELS = [
  "linkedin",
  "paid_meta",
  "paid_google",
  "referral",
  "seo",
  "partnerships",
  "content",
] as const;

export type ExperimentDepartment = (typeof EXPERIMENT_DEPARTMENTS)[number];
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ExperimentChannel = (typeof EXPERIMENT_CHANNELS)[number];

/**
 * experiments — growth (and cross-department) experiment ledger.
 *
 * Status lifecycle: proposed → running → completed | abandoned.
 *
 * ICE scoring: impact * confidence * ease, each 1..10. The DB enforces both
 * the per-component range CHECK and computes `iceScore` as a STORED generated
 * column (`/10` so the score sits in 0.1..100). Generated/stored means inserts
 * and updates auto-recompute it; clients NEVER write iceScore directly.
 *
 * `expectedCacCents` uses bigint to avoid losing precision on values above
 * 2^53 cents (well above any realistic CAC, but bigint is the correct type
 * for monetary cents in JS).
 *
 * DB-level CHECK constraints back the TS unions because $type<...>() is
 * erased at runtime — raw SQL writes, agent-generated migrations, and
 * future drizzle-kit pulls would otherwise drift silently.
 */
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    department: text("department")
      .$type<ExperimentDepartment>()
      .notNull()
      .default("growth"),
    hypothesis: text("hypothesis").notNull(),
    channel: text("channel").$type<ExperimentChannel>(),
    expectedLiftPct: real("expected_lift_pct"),
    expectedCacCents: bigint("expected_cac_cents", { mode: "bigint" }),
    iceImpact: integer("ice_impact").notNull(),
    iceConfidence: integer("ice_confidence").notNull(),
    iceEase: integer("ice_ease").notNull(),
    iceScore: real("ice_score").generatedAlwaysAs(
      sql`((ice_impact * ice_confidence * ice_ease)::real / 10)`,
    ),
    status: text("status")
      .$type<ExperimentStatus>()
      .notNull()
      .default("proposed"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    nextMilestone: text("next_milestone"),
    actualLiftPct: real("actual_lift_pct"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    byCompanyIce: index("experiments_company_ice_idx").on(
      t.companyId,
      t.iceScore,
    ),
    byCompanyStatus: index("experiments_company_status_idx").on(
      t.companyId,
      t.status,
    ),
  }),
);

export type Experiment = typeof experiments.$inferSelect;
export type ExperimentInsert = typeof experiments.$inferInsert;
