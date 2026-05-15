/**
 * daily-briefs-latest-route.test.ts — L2-C05 HTTP contract for
 * GET /api/companies/:id/daily-briefs/latest.
 *
 * Boots an Express app with the daily-briefs router mounted under /api,
 * stubs a board actor with access to a seeded company, and verifies:
 *   1. Returns 200 + { briefDate, payload } for the most-recent brief by forDate.
 *   2. Returns 404 with a helpful body when no briefs exist.
 *   3. Returns 403 when the caller is not a member of the company.
 *   4. Most-recent-wins when multiple rows exist across dates.
 *   5. Route ordering: /latest is not captured as a :briefId UUID lookup.
 *
 * Uses real embedded Postgres so the wire shape, drizzle date handling,
 * and assertCompanyAccess all run against the production DDL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  dailyBriefs,
  type DailyBriefPayload,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dailyBriefRoutes } from "../routes/daily-briefs.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping daily-briefs-latest-route tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function canonicalPayload(headline: string): DailyBriefPayload {
  return {
    headline,
    kpiMovements: [
      {
        metric: "MRR",
        from: "$0",
        to: "$0",
        delta: "flat",
        commentary: "Baseline.",
      },
    ],
    anomalies: [],
    blockers: [],
    opportunities: [],
    topThreeActions: [
      { action: "A", rationale: "r" },
      { action: "B", rationale: "r" },
      { action: "C", rationale: "r" },
    ],
  };
}

function buildApp(
  db: ReturnType<typeof createDb>,
  actor: {
    companyIds: string[];
    isInstanceAdmin?: boolean;
    source?: string;
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-test",
      companyIds: actor.companyIds,
      source: actor.source ?? "supabase_jwt",
      isInstanceAdmin: actor.isInstanceAdmin ?? false,
    };
    next();
  });
  app.use("/api", dailyBriefRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /api/companies/:id/daily-briefs/latest", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let prevStrict: string | undefined;

  beforeAll(async () => {
    // Ensure strict company isolation so the membership check actually fires
    // (default in dev/local is permissive — see assertCompanyAccess).
    prevStrict = process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION;
    process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION = "true";

    testDb = await startEmbeddedPostgresTestDatabase("daily-briefs-latest");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
    if (prevStrict === undefined) {
      delete process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION;
    } else {
      process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION = prevStrict;
    }
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "daily_briefs" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // Unique issue_prefix per company — the schema has a UNIQUE index on
    // `issue_prefix` and the default is "PAP" for all rows, so a 2-row
    // insert with defaults collides. Randomize per test run.
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const [c1] = await db
      .insert(companies)
      .values({ name: "Mira Labs", issuePrefix: `MA${suffix}` })
      .returning({ id: companies.id });
    const [c2] = await db
      .insert(companies)
      .values({ name: "Other Co", issuePrefix: `OT${suffix}` })
      .returning({ id: companies.id });
    companyId = c1!.id;
    otherCompanyId = c2!.id;
  });

  it("returns 404 when no brief exists for the company", async () => {
    const app = buildApp(db, { companyIds: [companyId] });

    const res = await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(404);

    expect(res.body).toMatchObject({
      error: expect.stringContaining("No daily brief"),
    });
  });

  it("returns 200 + { briefDate, payload } for the most-recent brief", async () => {
    const payload = canonicalPayload("Day 1 baseline.");
    await db.insert(dailyBriefs).values({
      companyId,
      forDate: "2026-05-12",
      payload,
    });

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(200);

    expect(res.body.briefDate).toBe("2026-05-12");
    expect(res.body.payload).toEqual(payload);
    // Shape contract: response is exactly { briefDate, payload }.
    expect(Object.keys(res.body).sort()).toEqual(["briefDate", "payload"]);
  });

  it("returns the most-recent brief when multiple dates exist", async () => {
    await db.insert(dailyBriefs).values({
      companyId,
      forDate: "2026-05-10",
      payload: canonicalPayload("Older."),
    });
    await db.insert(dailyBriefs).values({
      companyId,
      forDate: "2026-05-13",
      payload: canonicalPayload("Newest."),
    });
    await db.insert(dailyBriefs).values({
      companyId,
      forDate: "2026-05-11",
      payload: canonicalPayload("Middle."),
    });

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(200);

    expect(res.body.briefDate).toBe("2026-05-13");
    expect(res.body.payload.headline).toBe("Newest.");
  });

  it("does not return briefs from a different company", async () => {
    await db.insert(dailyBriefs).values({
      companyId: otherCompanyId,
      forDate: "2026-05-13",
      payload: canonicalPayload("Other co brief."),
    });

    const app = buildApp(db, { companyIds: [companyId] });

    // Caller has access to companyId, which has no briefs — 404 even though
    // a brief exists for otherCompanyId.
    await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(404);
  });

  it("returns 403 when the caller is not a member of the company", async () => {
    await db.insert(dailyBriefs).values({
      companyId,
      forDate: "2026-05-12",
      payload: canonicalPayload("Private brief."),
    });

    // Actor with no membership.
    const app = buildApp(db, { companyIds: ["unrelated-company-id"] });
    await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(403);
  });

  it("route ordering: /latest is NOT captured as :briefId UUID lookup", async () => {
    // No brief exists. If the literal "latest" were routed through the
    // :briefId handler, it would 404 with "Daily brief not found" — the
    // :briefId message. The /latest handler 404s with "No daily brief found
    // for this company". Use the body to disambiguate.
    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/companies/${companyId}/daily-briefs/latest`)
      .expect(404);

    expect(res.body.error).toContain("No daily brief");
  });
});
