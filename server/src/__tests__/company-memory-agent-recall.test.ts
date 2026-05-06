/**
 * Sprint 6 · S6.4 — agent memory schema integration tests.
 *
 * Validates the migration 0099 additions and service additions against
 * real Postgres:
 *   1. CHECK constraint rejects invalid `category` values
 *   2. CHECK constraint accepts NULL (uncategorized rows still allowed)
 *   3. TTL: rows whose expires_at < now() are excluded by recall + list({excludeExpired})
 *   4. recall() filters by category, tenant-scoped
 *   5. recall() filters by topic substring
 *   6. purgeExpired() deletes only rows where expires_at <= now()
 *   7. purgeExpired() is tenant-scoped when companyId is provided
 *
 * The vector(1536) embedding column is environment-dependent — Fly MPG ships
 * pgvector but PGlite's embedded-pg may not. We don't test embedding-cosine
 * recall here; that's a follow-up once an embedder is wired in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  companyMemory,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyMemoryService } from "../services/company-memory.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping company-memory-agent-recall tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("company memory — agent recall (S6.4)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof companyMemoryService>;
  let companyId: string;
  let otherCompanyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("company-memory-agent-recall");
    db = createDb(testDb.connectionString);
    service = companyMemoryService(db);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "company_memory" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const ts = Date.now();
    const [a] = await db
      .insert(companies)
      .values({ name: "Acme", slug: `acme-${ts}`, issuePrefix: `AC${ts}A` })
      .returning({ id: companies.id });
    const [b] = await db
      .insert(companies)
      .values({ name: "Beta", slug: `beta-${ts}`, issuePrefix: `AC${ts}B` })
      .returning({ id: companies.id });
    companyId = a.id;
    otherCompanyId = b.id;
  });

  it("CHECK constraint rejects invalid category values", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO "company_memory"
          ("company_id", "kind", "title", "body", "occurred_at", "source", "category")
        VALUES
          (${companyId}::uuid, 'founder_note', 'bad', 'bad', NOW(), 'manual', 'definitely-not-a-real-category')
      `),
    ).rejects.toThrow();
  });

  it("CHECK constraint allows NULL category (uncategorized memory still works)", async () => {
    const entry = await service.create(companyId, {
      kind: "founder_note",
      title: "uncategorized note",
      body: "no category set",
      source: "manual",
    });
    expect(entry.category).toBeNull();
  });

  it("CHECK constraint accepts each valid category value", async () => {
    for (const category of ["decision", "pattern", "context", "outcome"] as const) {
      const entry = await service.create(companyId, {
        kind: "founder_note",
        title: `${category} memory`,
        body: "body",
        source: "manual",
        category,
      });
      expect(entry.category).toBe(category);
    }
  });

  it("recall() filters by category and is tenant-scoped", async () => {
    await service.create(companyId, {
      kind: "founder_note",
      title: "Pricing decision",
      body: "Bumped enterprise tier to $499",
      source: "manual",
      category: "decision",
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Engineering pattern",
      body: "Always validate at boundaries",
      source: "manual",
      category: "pattern",
    });
    // Other company has a "decision" too — must NOT leak.
    await service.create(otherCompanyId, {
      kind: "founder_note",
      title: "Other co decision",
      body: "Should not appear in tenant A's recall",
      source: "manual",
      category: "decision",
    });

    const decisions = await service.recall(companyId, { category: "decision" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe("Pricing decision");
  });

  it("recall() filters by topic substring (case-insensitive)", async () => {
    await service.create(companyId, {
      kind: "founder_note",
      title: "Pricing thesis",
      body: "Enterprise pricing tier",
      topic: "pricing",
      source: "manual",
      category: "decision",
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Hiring plan",
      body: "Q2 senior hire",
      topic: "hiring",
      source: "manual",
      category: "decision",
    });

    const results = await service.recall(companyId, { topic: "PRIC" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Pricing thesis");
  });

  it("recall() excludes rows whose expires_at <= now()", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await service.create(companyId, {
      kind: "founder_note",
      title: "Expired decision",
      body: "old context",
      source: "manual",
      category: "decision",
      expiresAt: past,
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Live decision",
      body: "current",
      source: "manual",
      category: "decision",
      expiresAt: future,
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Permanent decision",
      body: "always relevant",
      source: "manual",
      category: "decision",
      // expiresAt left null → never expires
    });

    const results = await service.recall(companyId, { category: "decision" });
    expect(results.map((r) => r.title).sort()).toEqual([
      "Live decision",
      "Permanent decision",
    ]);
  });

  it("list({excludeExpired}) honors the same TTL behavior", async () => {
    const past = new Date(Date.now() - 60_000);

    await service.create(companyId, {
      kind: "founder_note",
      title: "Expired",
      body: "x",
      source: "manual",
      expiresAt: past,
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Live",
      body: "y",
      source: "manual",
    });

    const allRows = await service.list(companyId);
    expect(allRows).toHaveLength(2);

    const liveOnly = await service.list(companyId, { excludeExpired: true });
    expect(liveOnly).toHaveLength(1);
    expect(liveOnly[0].title).toBe("Live");
  });

  it("purgeExpired() deletes only expired rows and is tenant-scoped", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await service.create(companyId, {
      kind: "founder_note",
      title: "Co A expired",
      body: "x",
      source: "manual",
      expiresAt: past,
    });
    await service.create(companyId, {
      kind: "founder_note",
      title: "Co A live",
      body: "y",
      source: "manual",
      expiresAt: future,
    });
    await service.create(otherCompanyId, {
      kind: "founder_note",
      title: "Co B expired",
      body: "z",
      source: "manual",
      expiresAt: past,
    });

    const deletedForA = await service.purgeExpired(companyId);
    expect(deletedForA).toBe(1);

    // Co A should still have its live row; Co B's expired row should
    // remain because purge was tenant-scoped to companyA.
    const aRows = await service.list(companyId);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].title).toBe("Co A live");

    const bRows = await service.list(otherCompanyId);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].title).toBe("Co B expired");
  });

  it("purgeExpired() without companyId sweeps all tenants", async () => {
    const past = new Date(Date.now() - 60_000);

    await service.create(companyId, {
      kind: "founder_note",
      title: "Co A expired",
      body: "x",
      source: "manual",
      expiresAt: past,
    });
    await service.create(otherCompanyId, {
      kind: "founder_note",
      title: "Co B expired",
      body: "y",
      source: "manual",
      expiresAt: past,
    });

    const deleted = await service.purgeExpired();
    expect(deleted).toBe(2);
  });

  it("partial index idx_company_memory_company_category exists", async () => {
    const result = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'company_memory'
        AND indexname = 'idx_company_memory_company_category'
    `)) as unknown as Array<{ indexname: string }>;
    expect(result.length).toBe(1);
  });

  it("partial index idx_company_memory_expires_at exists", async () => {
    const result = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'company_memory'
        AND indexname = 'idx_company_memory_expires_at'
    `)) as unknown as Array<{ indexname: string }>;
    expect(result.length).toBe(1);
  });
});
