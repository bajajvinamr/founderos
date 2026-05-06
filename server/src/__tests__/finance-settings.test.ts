/**
 * Sprint 5 · S5.9 — finance settings GET/PUT integration tests.
 *
 * Validates:
 *   1. GET returns null when no row exists (founder hasn't filled in yet)
 *   2. PUT inserts on first call, returns hydrated row
 *   3. Second PUT upserts via onConflictDoUpdate (no duplicate row)
 *   4. lastUpdatedBy reflects authenticated actor
 *   5. activity_log row written on every upsert (audit trail)
 *   6. Invalid input (negative cents) → 400
 *
 * Uses embedded Postgres rather than mocked Drizzle so the UPSERT
 * conflict-target behaviour is exercised against real DB semantics —
 * mocking onConflictDoUpdate is the failure mode that S2.6 ingest
 * tests hit (task #125 in CLAUDE.md known pitfalls).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  activityLog,
  companies,
  companyFinancials,
  createDb,
} from "@founderos/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { financeSettingsRoutes } from "../routes/finance-settings.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping finance-settings tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("finance settings — GET/PUT singleton", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let app: express.Express;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("finance-settings");
    db = createDb(testDb.connectionString);

    app = express();
    app.use(express.json());
    // Inject a board actor so authz lets the request through. The role
    // check inside assertCompanyAccess looks for an actor object on req.
    app.use((req, _res, next) => {
      (req as unknown as {
        actor: {
          type: string;
          userId: string;
          source: string;
          isInstanceAdmin: boolean;
        };
      }).actor = {
        type: "board",
        userId: "test-founder",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", financeSettingsRoutes(db));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // Truncate finance + activity rows but keep companies — we just
    // create a fresh company per test with a unique prefix to avoid
    // the shared-fixture drift documented in CLAUDE.md episodes.
    await db.delete(companyFinancials);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({
        name: "Finance Settings Test Co",
        instanceId: "test-instance",
        issuePrefix: `FS${suffix}`,
      })
      .returning();
    companyId = company.id;
  });

  it("GET returns null before any settings exist", async () => {
    const res = await request(app)
      .get(`/api/companies/${companyId}/finance/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("PUT inserts a fresh row and returns hydrated payload", async () => {
    const res = await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({
        cashBalanceCents: 10_000_000,
        monthlyBurnCents: 2_000_000,
        currency: "USD",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId,
      cashBalanceCents: 10_000_000,
      monthlyBurnCents: 2_000_000,
      currency: "USD",
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.lastUpdatedBy).toContain("test-founder");
  });

  it("Second PUT upserts (no duplicate row, conflict target = company_id)", async () => {
    await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 10_000_000, monthlyBurnCents: 2_000_000 });

    const res2 = await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 12_000_000, monthlyBurnCents: 1_500_000 });

    expect(res2.status).toBe(200);
    expect(res2.body.cashBalanceCents).toBe(12_000_000);
    expect(res2.body.monthlyBurnCents).toBe(1_500_000);

    const allRows = await db
      .select()
      .from(companyFinancials)
      .where(eq(companyFinancials.companyId, companyId));
    expect(allRows).toHaveLength(1);
  });

  it("GET returns the upserted row after PUT", async () => {
    await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 8_500_000, monthlyBurnCents: 1_200_000 });

    const res = await request(app)
      .get(`/api/companies/${companyId}/finance/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId,
      cashBalanceCents: 8_500_000,
      monthlyBurnCents: 1_200_000,
      currency: "USD",
    });
    expect(res.body.lastUpdatedAt).toBeTruthy();
  });

  it("rejects negative cash balance", async () => {
    const res = await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: -1, monthlyBurnCents: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects non-integer cents", async () => {
    const res = await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 10.5, monthlyBurnCents: 1000 });
    expect(res.status).toBe(400);
  });

  it("writes an activity_log row on every upsert", async () => {
    await db.delete(activityLog);

    await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 5_000_000, monthlyBurnCents: 800_000 });

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const upsertLog = logs.find((l) => l.action === "finance.settings_upserted");
    expect(upsertLog).toBeDefined();
    expect(upsertLog?.entityType).toBe("company_financials");
  });

  it("currency defaults to USD when omitted", async () => {
    const res = await request(app)
      .put(`/api/companies/${companyId}/finance/settings`)
      .send({ cashBalanceCents: 1000, monthlyBurnCents: 100 });
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
  });
});
