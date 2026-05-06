import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Agent recall categories (S6.4) — semantic grouping orthogonal to `kind`.
 *
 * `kind` describes the source-of-record (weekly_summary | experiment_outcome |
 * founder_note | milestone). `category` describes the semantic role of the
 * memory for agent recall (decision the company made / pattern it noticed /
 * context to remember / outcome it observed). Same memory row can be a
 * weekly_summary by `kind` and a "decision" by `category`.
 *
 * Closed set; mirrored by the CHECK constraint on `category` in migration
 * 0099. Add new values via migration + this list together.
 */
export const COMPANY_MEMORY_CATEGORIES = [
  "decision",
  "pattern",
  "context",
  "outcome",
] as const;
export type CompanyMemoryCategory = (typeof COMPANY_MEMORY_CATEGORIES)[number];

export const COMPANY_MEMORY_EMBEDDING_DIM = 1536;

/**
 * pgvector(1536) — text-embedding-3-small dim. Used for cosine-similarity
 * recall ("which past memory is most relevant to this prompt?").
 *
 * In environments without pgvector (PGlite, vanilla Postgres without the
 * extension binary), migration 0099 falls back to a `text` placeholder
 * column. Code that writes embeddings should runtime-probe `pg_type`
 * before relying on the typed insert; agent recall paths fall back to
 * keyword/topic match.
 *
 * Note: a similar helper lives in `experiments.ts` (HYPOTHESIS_EMBEDDING_DIM
 * — also 1536). Kept duplicated for now per the project convention of
 * self-contained schema files; lift to shared utility if a third use case
 * appears.
 */
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${COMPANY_MEMORY_EMBEDDING_DIM})`;
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

export const companyMemory = pgTable(
  "company_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'weekly_summary' | 'experiment_outcome' | 'founder_note' | 'milestone'
    title: text("title").notNull(),
    body: text("body").notNull(),
    topic: text("topic"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    pinned: boolean("pinned").notNull().default(false),
    source: text("source").notNull(), // 'auto' | 'manual'
    /**
     * S6.4 — semantic role for agent recall. Closed set enforced by CHECK
     * constraint on the column ('decision' | 'pattern' | 'context' | 'outcome').
     * NULL when no semantic categorization is needed.
     */
    category: text("category").$type<CompanyMemoryCategory | null>(),
    /**
     * S6.4 — vector(1536) when pgvector is loaded; text fallback otherwise.
     * Migration 0099 picks the column type at deploy time.
     */
    embedding: vector1536("embedding"),
    /**
     * S6.4 — TTL for time-sensitive memory. NULL = no expiry (default).
     * Cleanup query reads `WHERE expires_at < now()` against the partial
     * index `idx_company_memory_expires_at`.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("idx_company_memory_company_occurred").on(table.companyId, table.occurredAt),
    pinnedIdx: index("idx_company_memory_pinned").on(table.companyId, table.pinned),
    /**
     * S6.4 — agent recall query path: "show me past DECISIONS for this
     * company" / "show me past PATTERNS". Partial index — only carries
     * rows with a non-null category to keep the index small.
     */
    companyCategoryIdx: index("idx_company_memory_company_category").on(table.companyId, table.category),
    /**
     * S6.4 — TTL cleanup query path. Partial index — most rows have no
     * expiry, so the index only carries rows where expires_at is set.
     */
    expiresAtIdx: index("idx_company_memory_expires_at").on(table.expiresAt),
  }),
);
