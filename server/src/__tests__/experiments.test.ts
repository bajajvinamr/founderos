/**
 * experiments.test.ts — integration tests for the Experiments API (S3.5).
 *
 * Covers:
 *   1. POST creates with valid ICE; ice_score is auto-computed by the DB
 *   2. GET returns rows sorted by ice_score DESC by default
 *   3. PATCH transitions status (proposed → running → completed)
 *   4. GET ?channel= filters correctly
 *   5. CHECK constraint rejects ice_impact=11 (out of 1..10 band)
 *   6. CHECK constraint rejects an unknown channel value
 *   7. ICE generated column recomputes on insert (sanity)
 *
 * Uses real embedded Postgres so the GENERATED ALWAYS AS, CHECK constraints,
 * FK CASCADE on companies, and index ordering are exercised end-to-end
 * against the real DDL.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { experimentRoutes } from "../routes/experiments.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping experiments tests: ${support.reason ?? "unsupported environment"}`,
  );
}

function buildApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: ["__company_id_placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  return app;
}

describeEmbeddedPostgres("Experiments API", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-experiments-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes experiments via FK ON DELETE CASCADE.
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Corp" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = buildApp({ companyIds: [companyId], ...overrides });
    app.use("/api", experimentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── POST + generated column ───────────────────────────────────────────────

  it("POST creates an experiment and DB computes ice_score", async () => {
    const app = makeApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({
        hypothesis: "Tighten hero copy",
        channel: "linkedin",
        iceImpact: 8,
        iceConfidence: 7,
        iceEase: 5,
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.hypothesis).toBe("Tighten hero copy");
    expect(res.body.channel).toBe("linkedin");
    expect(res.body.status).toBe("proposed");
    expect(res.body.department).toBe("growth");
    // 8 * 7 * 5 / 10 = 28
    expect(Number(res.body.iceScore)).toBeCloseTo(28, 5);
  });

  // ── GET sort order ────────────────────────────────────────────────────────

  it("GET returns rows sorted by ice_score DESC", async () => {
    const app = makeApp();

    // Low ICE — 2 * 2 * 2 / 10 = 0.8
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Low score idea", iceImpact: 2, iceConfidence: 2, iceEase: 2 })
      .expect(201);

    // High ICE — 10 * 9 * 8 / 10 = 72
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Top priority", iceImpact: 10, iceConfidence: 9, iceEase: 8 })
      .expect(201);

    // Mid ICE — 6 * 6 * 6 / 10 = 21.6
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Mid lift", iceImpact: 6, iceConfidence: 6, iceEase: 6 })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/experiments`)
      .expect(200);

    expect(res.body).toHaveLength(3);
    expect(res.body[0].hypothesis).toBe("Top priority");
    expect(res.body[1].hypothesis).toBe("Mid lift");
    expect(res.body[2].hypothesis).toBe("Low score idea");
  });

  // ── PATCH status transitions ──────────────────────────────────────────────

  it("PATCH transitions status proposed → running → completed", async () => {
    const app = makeApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Cycle me", iceImpact: 7, iceConfidence: 7, iceEase: 7 })
      .expect(201);
    const expId = created.body.id as string;

    const running = await request(app)
      .patch(`/api/companies/${companyId}/experiments/${expId}`)
      .send({ status: "running" })
      .expect(200);
    expect(running.body.status).toBe("running");

    const completed = await request(app)
      .patch(`/api/companies/${companyId}/experiments/${expId}`)
      .send({ status: "completed", actualLiftPct: 12.5 })
      .expect(200);
    expect(completed.body.status).toBe("completed");
    expect(completed.body.actualLiftPct).toBeCloseTo(12.5, 5);
  });

  it("PATCH returns 404 for unknown experiment id", async () => {
    const app = makeApp();
    await request(app)
      .patch(`/api/companies/${companyId}/experiments/00000000-0000-0000-0000-000000000000`)
      .send({ status: "running" })
      .expect(404);
  });

  // ── Channel filter ────────────────────────────────────────────────────────

  it("GET ?channel= filters to the matching channel", async () => {
    const app = makeApp();
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "LI A", channel: "linkedin", iceImpact: 5, iceConfidence: 5, iceEase: 5 })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Referral B", channel: "referral", iceImpact: 5, iceConfidence: 5, iceEase: 5 })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "LI C", channel: "linkedin", iceImpact: 6, iceConfidence: 6, iceEase: 6 })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/experiments?channel=linkedin`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    for (const row of res.body) {
      expect(row.channel).toBe("linkedin");
    }
  });

  it("GET ?status= filters to the matching status", async () => {
    const app = makeApp();
    const a = await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "X", iceImpact: 5, iceConfidence: 5, iceEase: 5 })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "Y", iceImpact: 5, iceConfidence: 5, iceEase: 5 })
      .expect(201);

    await request(app)
      .patch(`/api/companies/${companyId}/experiments/${a.body.id}`)
      .send({ status: "running" })
      .expect(200);

    const res = await request(app)
      .get(`/api/companies/${companyId}/experiments?status=running`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("running");
  });

  // ── CHECK constraint enforcement ──────────────────────────────────────────

  it("rejects ice_impact=11 via DB CHECK constraint", async () => {
    // Bypass the route's Zod gate by writing directly through Drizzle, so we
    // verify the DB-level CHECK fires (defense in depth — TS unions and Zod
    // are erased at runtime when a raw SQL writer or future migration drifts).
    await expect(
      db.execute(
        sql`INSERT INTO "experiments" ("company_id","hypothesis","ice_impact","ice_confidence","ice_ease")
            VALUES (${companyId}, 'bad-impact', 11, 5, 5)`,
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown channel via DB CHECK constraint", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO "experiments" ("company_id","hypothesis","ice_impact","ice_confidence","ice_ease","channel")
            VALUES (${companyId}, 'bad-channel', 5, 5, 5, 'tiktok')`,
      ),
    ).rejects.toThrow();
  });

  it("Zod rejects ice_impact=11 at the route layer (400)", async () => {
    const app = makeApp();
    await request(app)
      .post(`/api/companies/${companyId}/experiments`)
      .send({ hypothesis: "bad", iceImpact: 11, iceConfidence: 5, iceEase: 5 })
      .expect(400);
  });
});
