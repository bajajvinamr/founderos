import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  bigint,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * pgvector `vector(1536)` custom type. 1536 dim matches OpenAI's
 * text-embedding-3-small. Stored as `[v1,v2,...]` literal which pgvector
 * accepts and we read back into a `number[]` via the parser branch.
 *
 * pgvector has no driver-level binary protocol in node-postgres, so the
 * value is passed as text. The parser accepts the `[..]` literal pgvector
 * returns when SELECT'd as the column type.
 *
 * In environments that don't ship pgvector (PGlite tests, Postgres without
 * the extension), the migration will fail at `CREATE EXTENSION vector` and
 * tests that depend on this column should be wrapped with a runtime
 * `CREATE EXTENSION` probe + describe.skip.
 */
export const HYPOTHESIS_EMBEDDING_DIM = 1536;

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${HYPOTHESIS_EMBEDDING_DIM})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    if (typeof value !== "string") return [];
    const trimmed = value.trim().replace(/^\[|\]$/g, "");
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map((s) => Number.parseFloat(s.trim()));
  },
});

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
    /**
     * Embedding of the hypothesis text used for cosine-similarity dedup
     * across `proposed` rows (S3.6). Nullable because:
     *   1. Existing rows pre-S3.6 have no embedding.
     *   2. Environments without pgvector (PGlite tests, dev) store NULL
     *      and fall back to title-hash dedup.
     * Index: `experiments_hypothesis_embedding_idx` HNSW with vector_cosine_ops
     * (created in migration 0084 — Drizzle has no native HNSW DSL).
     */
    hypothesisEmbedding: vector1536("hypothesis_embedding"),
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
