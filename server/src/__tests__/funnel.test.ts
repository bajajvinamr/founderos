/**
 * funnel.test.ts — integration tests for the Funnel diagnostics API (S3.7).
 *
 * Cases covered:
 *   1. Synthetic 30d data → 5-step funnel returns expected counts and drops
 *   2. Worst-step identification picks the step with the largest drop
 *   3. Empty workspace → all-zero steps array, worstStep null
 *   4. Threshold crossed → an insight row of kind='blocker' is created
 *   5. Multi-call within 24h → no duplicate insight (idempotent dedup)
 *
 * Uses real embedded Postgres so the JSONB extraction (payload->>'distinctId')
 * and DB-level CHECK constraints are exercised end-to-end.
 *
 * Notes on event seeding: we insert directly via Drizzle (not the production
 * ingest path), so initEventIngest is unnecessary. distinctId is stored in
 * payload — the funnel route reads it via JSONB path.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { companies, createDb, events, insights } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { funnelRoutes } from "../routes/funnel.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping funnel tests: ${support.reason ?? "unsupported environment"}`,
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

/**
 * Seed N distinct users at a given step. Each user gets a unique
 * `payload.distinctId` so the COUNT(DISTINCT) aggregation produces N.
 */
async function seedEvents(
  db: ReturnType<typeof createDb>,
  companyId: string,
  eventName: string,
  count: number,
  opts: { startId?: number; daysAgo?: number } = {},
) {
  const startId = opts.startId ?? 0;
  const daysAgo = opts.daysAgo ?? 1;
  const occurredAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const rows = Array.from({ length: count }, (_, i) => ({
    companyId,
    source: "posthog" as const,
    entityType: "event",
    eventName,
    dedupKey: `funnel-test:${eventName}:${startId + i}`,
    occurredAt,
    payload: { distinctId: `user-${startId + i}` } as Record<string, unknown>,
  }));
  if (rows.length > 0) {
    await db.insert(events).values(rows);
  }
}

describeEmbeddedPostgres("Funnel API (S3.7)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("funnel");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes insights via FK ON DELETE CASCADE; events use RESTRICT
    // so we must explicitly clear them before truncating companies.
    await db.execute(sql`DELETE FROM "events"`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Funnel Test Corp" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = buildApp({ companyIds: [companyId], ...overrides });
    app.use("/api", funnelRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── 1. Synthetic 30d data → expected counts + drops ──────────────────────

  it("returns the 5-step funnel with correct counts and drop fractions", async () => {
    // Seed a clean funnel: 100 → 50 → 25 → 10 → 5 distinct users.
    await seedEvents(db, companyId, "pageview", 100, { startId: 0 });
    await seedEvents(db, companyId, "identify", 50, { startId: 0 });
    await seedEvents(db, companyId, "activated", 25, { startId: 0 });
    await seedEvents(db, companyId, "retained_7d", 10, { startId: 0 });
    await seedEvents(db, companyId, "subscribed", 5, { startId: 0 });

    const app = makeApp();
    const res = await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    expect(res.body.steps).toHaveLength(5);
    expect(res.body.steps[0]).toMatchObject({ name: "Traffic", count: 100, dropFromPrev: null });
    expect(res.body.steps[1].name).toBe("Signup");
    expect(res.body.steps[1].count).toBe(50);
    expect(res.body.steps[1].dropFromPrev).toBeCloseTo(0.5, 5);
    expect(res.body.steps[2].name).toBe("Activation");
    expect(res.body.steps[2].count).toBe(25);
    expect(res.body.steps[2].dropFromPrev).toBeCloseTo(0.5, 5);
    expect(res.body.steps[3].name).toBe("Retention");
    expect(res.body.steps[3].count).toBe(10);
    expect(res.body.steps[3].dropFromPrev).toBeCloseTo(0.6, 5);
    expect(res.body.steps[4].name).toBe("Paid");
    expect(res.body.steps[4].count).toBe(5);
    expect(res.body.steps[4].dropFromPrev).toBeCloseTo(0.5, 5);
  });

  // ── 2. Worst-step identification ─────────────────────────────────────────

  it("identifies the step with the largest drop as worstStep", async () => {
    // Drops: 0.20, 0.66 (worst), 0.30, 0.10. Worst is identify→activated.
    await seedEvents(db, companyId, "pageview", 100, { startId: 0 });
    await seedEvents(db, companyId, "identify", 80, { startId: 0 });
    await seedEvents(db, companyId, "activated", 27, { startId: 0 });
    await seedEvents(db, companyId, "retained_7d", 19, { startId: 0 });
    await seedEvents(db, companyId, "subscribed", 17, { startId: 0 });

    const app = makeApp();
    const res = await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    expect(res.body.worstStep).toBe("Activation");
  });

  // ── 3. Empty workspace ───────────────────────────────────────────────────

  it("returns zero counts and null worstStep when no events exist", async () => {
    const app = makeApp();
    const res = await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    expect(res.body.steps).toHaveLength(5);
    for (const s of res.body.steps) {
      expect(s.count).toBe(0);
    }
    expect(res.body.steps[0].dropFromPrev).toBeNull();
    // With prev=0 we surface null (undefined drop), so the worst-finder
    // sees no eligible step and returns null.
    expect(res.body.worstStep).toBeNull();
  });

  // ── 4. Threshold crossed → blocker insight written ───────────────────────

  it("writes a blocker insight when worstStep dropFromPrev > 0.5", async () => {
    // 80% drop on Paid step.
    await seedEvents(db, companyId, "pageview", 100, { startId: 0 });
    await seedEvents(db, companyId, "identify", 90, { startId: 0 });
    await seedEvents(db, companyId, "activated", 80, { startId: 0 });
    await seedEvents(db, companyId, "retained_7d", 70, { startId: 0 });
    await seedEvents(db, companyId, "subscribed", 14, { startId: 0 });

    const app = makeApp();
    const res = await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    expect(res.body.worstStep).toBe("Paid");

    const rows = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.companyId, companyId), eq(insights.kind, "blocker")),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Funnel drop-off at Paid");
    expect(rows[0].department).toBe("growth");
    expect(rows[0].status).toBe("open");
    // evidence carries the full snapshot for downstream agents.
    const evidence = rows[0].evidence as { steps: unknown[]; worstStep: string };
    expect(evidence.worstStep).toBe("Paid");
    expect(Array.isArray(evidence.steps)).toBe(true);
  });

  // ── 5. Idempotency within 24h ────────────────────────────────────────────

  it("does not duplicate the insight on a repeat call within 24h", async () => {
    await seedEvents(db, companyId, "pageview", 100, { startId: 0 });
    await seedEvents(db, companyId, "identify", 90, { startId: 0 });
    await seedEvents(db, companyId, "activated", 80, { startId: 0 });
    await seedEvents(db, companyId, "retained_7d", 70, { startId: 0 });
    await seedEvents(db, companyId, "subscribed", 14, { startId: 0 });

    const app = makeApp();
    await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);
    await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);
    await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    const rows = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.companyId, companyId), eq(insights.kind, "blocker")),
      );

    expect(rows).toHaveLength(1);
  });

  // ── 6. Sub-threshold drop → no insight ───────────────────────────────────

  it("does not write an insight when worst drop is below 0.5 threshold", async () => {
    // Max drop is 0.4; threshold is strictly > 0.5.
    await seedEvents(db, companyId, "pageview", 100, { startId: 0 });
    await seedEvents(db, companyId, "identify", 80, { startId: 0 });
    await seedEvents(db, companyId, "activated", 60, { startId: 0 });
    await seedEvents(db, companyId, "retained_7d", 50, { startId: 0 });
    await seedEvents(db, companyId, "subscribed", 30, { startId: 0 });

    const app = makeApp();
    await request(app).get(`/api/companies/${companyId}/funnel`).expect(200);

    const rows = await db
      .select()
      .from(insights)
      .where(
        and(eq(insights.companyId, companyId), eq(insights.kind, "blocker")),
      );
    expect(rows).toHaveLength(0);
  });
});
