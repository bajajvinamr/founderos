/**
 * insights.test.ts — integration tests for the insights schema + API (S3.1).
 *
 * Covers (per ticket spec):
 *   1. insert → list returns the row
 *   2. status transition open → acted_on succeeds
 *   3. dismissed → open rejected with 409
 *   4. kind filter narrows results
 *   5. status filter narrows results
 *   6. CHECK constraint rejects an invalid kind value (raw SQL bypass)
 *
 * Plus a few targeted guards against the gotchas the spec called out:
 *   - .where(and(...)) AND'ing both filters at once (chained .where()
 *     would silently replace the first predicate)
 *   - Zod boundary on POST body (out-of-range confidence rejected at 400
 *     before ever hitting the DB CHECK)
 *
 * Real embedded Postgres is used so CHECK constraints, the FK CASCADE, and
 * the (company_id, kind, created_at DESC) index are exercised end-to-end.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, insights } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { insightRoutes } from "../routes/insights.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping insights tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Insights API (S3.1)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-insights-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Truncate insights then companies — FK CASCADE handles ordering, but
    // explicit ordering keeps the failure mode obvious if CASCADE is ever
    // dropped from the migration.
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Insights Test Co" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  function buildApp(actorOverrides: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).actor = {
        type: "board",
        userId: "user-test",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
        ...actorOverrides,
      };
      next();
    });
    app.use("/api", insightRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── (1) insert → list returns ──────────────────────────────────────────

  it("(1) inserts an insight and lists it back", async () => {
    const app = buildApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/insights`)
      .send({
        department: "growth",
        kind: "experiment_suggestion",
        title: "Try LinkedIn DMs to design leads",
        body: "Replies are 3x cold email; 8 design leaders tested.",
        confidence: 0.78,
        recommendation: "Run a 2-week pilot with 50 DMs/week.",
        evidence: { sampleSize: 8, replyRate: 0.41 },
      })
      .expect(201);

    expect(typeof created.body.id).toBe("string");
    expect(created.body.companyId).toBe(companyId);
    expect(created.body.status).toBe("open");

    const listed = await request(app)
      .get(`/api/companies/${companyId}/insights`)
      .expect(200);

    expect(Array.isArray(listed.body.insights)).toBe(true);
    expect(listed.body.insights).toHaveLength(1);
    expect(listed.body.insights[0].id).toBe(created.body.id);
    expect(listed.body.insights[0].kind).toBe("experiment_suggestion");
    expect(listed.body.meta).toMatchObject({ count: 1, offset: 0 });
  });

  // ── (2) status open → acted_on ─────────────────────────────────────────

  it("(2) PATCH transitions status from open to acted_on", async () => {
    const app = buildApp();

    const [row] = await db
      .insert(insights)
      .values({
        companyId,
        department: "chief-of-staff",
        kind: "blocker",
        title: "Founder calendar fragmented",
        body: "12 small meetings/week, no 4h focus block.",
        confidence: 0.92,
        evidence: { meetingCount: 12 },
      })
      .returning();

    const res = await request(app)
      .patch(`/api/companies/${companyId}/insights/${row!.id}`)
      .send({
        status: "acted_on",
        outcomeNote: "Blocked Mon/Wed mornings via Calendar.",
      })
      .expect(200);

    expect(res.body.status).toBe("acted_on");
    expect(res.body.outcomeNote).toBe("Blocked Mon/Wed mornings via Calendar.");
  });

  // ── (3) dismissed → open rejected with 409 ────────────────────────────

  it("(3) rejects status transition dismissed → open with 409", async () => {
    const app = buildApp();

    const [row] = await db
      .insert(insights)
      .values({
        companyId,
        department: "growth",
        kind: "channel_recommendation",
        title: "Try Reddit for SEO",
        body: "Reddit answers rank well for our keywords.",
        confidence: 0.55,
        evidence: { rankings: [3, 5, 7] },
        status: "dismissed",
      })
      .returning();

    const res = await request(app)
      .patch(`/api/companies/${companyId}/insights/${row!.id}`)
      .send({ status: "open" })
      .expect(409);

    expect(res.body.error).toMatch(/Cannot reopen a dismissed insight/);

    // Status must remain dismissed in DB.
    const [reread] = await db
      .select()
      .from(insights)
      .where(sql`"id" = ${row!.id}`);
    expect(reread!.status).toBe("dismissed");
  });

  // ── (4) kind filter ────────────────────────────────────────────────────

  it("(4) GET ?kind=blocker narrows to blocker rows only", async () => {
    const app = buildApp();

    await db.insert(insights).values([
      {
        companyId,
        department: "chief-of-staff",
        kind: "blocker",
        title: "Blocker A",
        body: "A",
        confidence: 0.9,
        evidence: {},
      },
      {
        companyId,
        department: "growth",
        kind: "opportunity",
        title: "Opportunity B",
        body: "B",
        confidence: 0.7,
        evidence: {},
      },
      {
        companyId,
        department: "finance",
        kind: "blocker",
        title: "Blocker C",
        body: "C",
        confidence: 0.6,
        evidence: {},
      },
    ]);

    const res = await request(app)
      .get(`/api/companies/${companyId}/insights?kind=blocker`)
      .expect(200);

    expect(res.body.insights).toHaveLength(2);
    for (const row of res.body.insights) {
      expect(row.kind).toBe("blocker");
    }
  });

  // ── (5) status filter ──────────────────────────────────────────────────

  it("(5) GET ?status=open returns only open rows (and combines with kind)", async () => {
    const app = buildApp();

    await db.insert(insights).values([
      {
        companyId,
        department: "growth",
        kind: "kpi_anomaly",
        title: "Open anomaly",
        body: "x",
        confidence: 0.8,
        evidence: {},
        status: "open",
      },
      {
        companyId,
        department: "growth",
        kind: "kpi_anomaly",
        title: "Acted anomaly",
        body: "x",
        confidence: 0.8,
        evidence: {},
        status: "acted_on",
      },
      {
        companyId,
        department: "crm",
        kind: "opportunity",
        title: "Open opportunity",
        body: "x",
        confidence: 0.8,
        evidence: {},
        status: "open",
      },
    ]);

    // status=open alone → 2 rows
    const open = await request(app)
      .get(`/api/companies/${companyId}/insights?status=open`)
      .expect(200);
    expect(open.body.insights).toHaveLength(2);
    for (const row of open.body.insights) {
      expect(row.status).toBe("open");
    }

    // status=open AND kind=kpi_anomaly → 1 row
    // (Verifies .where(and(...)) actually composes both predicates;
    //  Drizzle's chained .where() would silently replace the first.)
    const both = await request(app)
      .get(
        `/api/companies/${companyId}/insights?status=open&kind=kpi_anomaly`,
      )
      .expect(200);
    expect(both.body.insights).toHaveLength(1);
    expect(both.body.insights[0].title).toBe("Open anomaly");
  });

  // ── (6) DB-level CHECK rejects invalid kind via raw SQL ───────────────

  it("(6) CHECK constraint rejects an invalid kind via raw SQL bypass", async () => {
    // Bypass the typed insert path (Drizzle's $type<InsightKind>() is erased
    // at runtime). The CHECK constraint MUST reject this at the SQL layer.
    await expect(
      db.execute(sql`
        INSERT INTO "insights"
          ("company_id","department","kind","title","body","confidence","evidence")
        VALUES
          (${companyId},'growth','not_a_real_kind','x','x',0.5,'{}'::jsonb)
      `),
    ).rejects.toThrow(/insights_kind_check|check constraint/i);
  });

  // ── Bonus: Zod rejects out-of-range confidence at the API boundary ────

  it("(bonus) POST rejects confidence > 1 with a 400 (Zod boundary)", async () => {
    const app = buildApp();

    await request(app)
      .post(`/api/companies/${companyId}/insights`)
      .send({
        department: "finance",
        kind: "kpi_anomaly",
        title: "Bad confidence",
        body: "x",
        confidence: 1.5,
        evidence: {},
      })
      .expect(400);
  });
});
