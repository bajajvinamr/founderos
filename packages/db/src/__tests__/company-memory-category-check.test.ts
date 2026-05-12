/**
 * Structural test for `company_memory.category` CHECK constraint (S6.4 invariant defense).
 *
 * Backstops the vinamr-invariant documented in CLAUDE.md:
 *
 *   "`company_memory.category` is CHECK-constrained at the DB (S6.4, 2026-05-06).
 *    TS union types erase at compile time, so raw SQL inserts and migrations
 *    bypass the type. The CHECK enforces the enum at the runtime backstop —
 *    same pattern as `events.source`. When adding a new memory category,
 *    update both the validator (`memoryCategorySchema` in `packages/shared`)
 *    AND the CHECK constraint in a migration."
 *
 * Regression risks this guards against:
 *   1. Dropping the CHECK constraint to "simplify the schema" → arbitrary
 *      strings flow in via raw SQL paths.
 *   2. Adding a new enum value to `memoryCategorySchema` without updating
 *      the CHECK → app-layer validation passes but DB rejects.
 *   3. Removing an enum value from the CHECK while existing rows still hold
 *      that value → migration fails or data becomes inaccessible.
 *
 * Coverage layers:
 *   • Static — migration SQL contains `CHECK (..."category" IN (...))` with
 *     at least 2 distinct enum members.
 *   • Drift — CHECK constraint values are a SUPERSET of `memoryCategorySchema`
 *     (the DB rejecting a value the validator accepts is the silent-bug shape).
 *   • Runtime negative — raw SQL INSERT with an invalid category is rejected
 *     by Postgres with a CHECK violation.
 *   • Runtime positive — INSERT with each valid enum value succeeds.
 *
 * Ticket: L2-D29 (Lane D, invariant defense). Loop 2 overnight worker.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { memoryCategorySchema } from "@founderos/shared";
import { COMPANY_MEMORY_CATEGORIES } from "../schema/company_memory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const MIGRATION_FILENAME = "0099_company_memory_agent_recall.sql";

function readMigration(): string {
  const url = new URL(`../migrations/${MIGRATION_FILENAME}`, import.meta.url);
  return fs.readFileSync(url, "utf8");
}

function extractCheckEnumValues(sql: string): string[] {
  // Capture the body of `"category" IN ( ... )` — quote-aware, multi-line tolerant.
  const inClauseMatch = sql.match(
    /"category"\s+IN\s*\(\s*([^)]+?)\s*\)/i,
  );
  if (!inClauseMatch) return [];
  const body = inClauseMatch[1];
  if (!body) return [];
  // Extract single-quoted string literals.
  const literals = body.match(/'([^']+)'/g) ?? [];
  return literals.map((lit) => lit.slice(1, -1));
}

describe("migration 0099 — company_memory.category CHECK constraint (static)", () => {
  const migrationSql = readMigration();

  it("declares a CHECK constraint named company_memory_category_check", () => {
    expect(migrationSql).toMatch(/company_memory_category_check/);
    expect(migrationSql).toMatch(/ADD\s+CONSTRAINT\s+"company_memory_category_check"/i);
  });

  it("CHECK clause references the category column with an IN (...) value list", () => {
    expect(migrationSql).toMatch(/CHECK\s*\([\s\S]*?"category"[\s\S]*?\)/i);
    const values = extractCheckEnumValues(migrationSql);
    // At least two distinct enum members — protects against the "constraint
    // exists but accepts only one value" silent-drop case.
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(new Set(values).size).toBe(values.length);
  });

  it("CHECK constraint values are a SUPERSET of memoryCategorySchema enum", () => {
    // Drift detector: shared validator can never be more permissive than the
    // DB CHECK, or invalid rows pass the app layer and fail the DB at insert
    // time (silent-bug shape). Direction matters — DB ⊇ shared, not the
    // reverse.
    const checkValues = new Set(extractCheckEnumValues(migrationSql));
    const sharedValues = memoryCategorySchema.options as readonly string[];

    const missingFromCheck = sharedValues.filter((v) => !checkValues.has(v));
    expect(missingFromCheck).toEqual([]);

    // Both sources should also agree with the schema const. If this fails,
    // someone updated the migration or the validator without updating the
    // schema const used by the agent recall code path.
    const schemaConst = new Set<string>(COMPANY_MEMORY_CATEGORIES);
    expect([...schemaConst].sort()).toEqual([...sharedValues].sort());
  });
});

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CHECK-constraint runtime tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase(
    "founderos-company-memory-check-",
  );
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function insertCompany(
  sql: postgres.Sql,
  name: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO "companies" ("name") VALUES (${name}) RETURNING "id"
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("Failed to insert companies row");
  return id;
}

describeEmbeddedPostgres(
  "company_memory.category CHECK constraint (runtime)",
  () => {
    it(
      "rejects raw SQL INSERT with an invalid category value",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const companyId = await insertCompany(sql, "L2-D29 reject case");

          // Bypass the Drizzle/TS layer entirely — go straight to raw SQL.
          // The CHECK constraint is the only guard against this path.
          await expect(
            sql`
              INSERT INTO "company_memory"
                ("company_id", "kind", "title", "body", "occurred_at", "source", "category")
              VALUES
                (${companyId}, 'founder_note', 'invalid-category test',
                 'this row should be rejected', now(), 'manual',
                 'definitely-not-an-enum-value')
            `,
          ).rejects.toMatchObject({
            // pg error code for check_violation = '23514'.
            code: "23514",
          });
        } finally {
          await sql.end();
        }
      },
      30_000,
    );

    it(
      "accepts raw SQL INSERT for every valid memoryCategorySchema enum value",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const companyId = await insertCompany(sql, "L2-D29 accept cases");
          const values = memoryCategorySchema.options as readonly string[];

          for (const category of values) {
            await sql`
              INSERT INTO "company_memory"
                ("company_id", "kind", "title", "body", "occurred_at", "source", "category")
              VALUES
                (${companyId}, 'founder_note', ${`accept-${category}`},
                 ${`valid category ${category}`}, now(), 'manual', ${category})
            `;
          }

          const rows = await sql<{ category: string | null }[]>`
            SELECT "category" FROM "company_memory"
            WHERE "company_id" = ${companyId}
              AND "category" IS NOT NULL
            ORDER BY "category"
          `;
          expect(rows.map((r) => r.category)).toEqual(
            [...values].sort(),
          );
        } finally {
          await sql.end();
        }
      },
      30_000,
    );

    it(
      "accepts NULL category (the constraint is permissive on absent categorization)",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const companyId = await insertCompany(sql, "L2-D29 null case");
          await sql`
            INSERT INTO "company_memory"
              ("company_id", "kind", "title", "body", "occurred_at", "source", "category")
            VALUES
              (${companyId}, 'founder_note', 'null-category test',
               'category column is NULL', now(), 'manual', NULL)
          `;

          const rows = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM "company_memory"
            WHERE "company_id" = ${companyId} AND "category" IS NULL
          `;
          expect(rows[0]?.count).toBe("1");
        } finally {
          await sql.end();
        }
      },
      30_000,
    );

    it(
      "constraint is present in pg_constraint with the expected name",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const rows = await sql<{ conname: string }[]>`
            SELECT conname FROM pg_constraint
            WHERE conname = 'company_memory_category_check'
          `;
          expect(rows).toHaveLength(1);
        } finally {
          await sql.end();
        }
      },
      30_000,
    );
  },
);
