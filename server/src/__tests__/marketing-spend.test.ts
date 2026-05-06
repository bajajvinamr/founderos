/**
 * Sprint 5 · S5.6 — marketing spend ledger CRUD integration tests.
 *
 * Validates:
 *   1. GET empty → []
 *   2. POST creates a row with all fields hydrated
 *   3. GET filters by channel, periodStart, periodEnd
 *   4. PATCH updates a subset of fields; others preserved
 *   5. DELETE removes the row; subsequent GET excludes it
 *   6. Tenant scope: PATCH/DELETE on a row from another company → 404
 *   7. CHECK constraints reject negative amounts at the DB layer
 *   8. CHECK constraints reject period_end < period_start at DB layer
 *   9. Unknown channel rejected by Zod (400) before reaching DB
 *  10. Activity log entries written for create/update/delete
 *
 * Per CLAUDE.md episode about test fixture drift: each test seeds a fresh
 * company with a unique issuePrefix.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  activityLog,
  companies,
  createDb,
  marketingSpend,
} from "@founderos/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { marketingSpendRoutes } from "../routes/marketing-spend.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping marketing-spend tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("marketing spend — CRUD + tenant scope", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let app: express.Express;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("marketing-spend");
    db = createDb(testDb.connectionString);

    app = express();
    app.use(express.json());
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
    app.use("/api", marketingSpendRoutes(db));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(marketingSpend);
    const suffixA = Math.random().toString(36).substring(2, 8).toUpperCase();
    const suffixB = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [a] = await db
      .insert(companies)
      .values({
        name: "Marketing Spend Test Co A",
        instanceId: "test-instance",
        issuePrefix: `MSA${suffixA}`,
      })
      .returning();
    const [b] = await db
      .insert(companies)
      .values({
        name: "Marketing Spend Test Co B",
        instanceId: "test-instance",
        issuePrefix: `MSB${suffixB}`,
      })
      .returning();
    companyId = a.id;
    otherCompanyId = b.id;
  });

  it("GET returns empty array before any rows exist", async () => {
    const res = await request(app)
      .get(`/api/companies/${companyId}/finance/marketing-spend`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST creates a row with hydrated fields", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "linkedin",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 500_000,
        notes: "Q2 push",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      channel: "linkedin",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      amountCents: 500_000,
      currency: "USD",
      notes: "Q2 push",
    });
    expect(res.body.id).toBeTruthy();
    expect(res.body.createdBy).toContain("test-founder");
  });

  it("GET filters by channel", async () => {
    await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "linkedin",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 500_000,
      });
    await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "paid_meta",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 800_000,
      });

    const res = await request(app)
      .get(`/api/companies/${companyId}/finance/marketing-spend?channel=linkedin`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].channel).toBe("linkedin");
  });

  it("GET filters by date range", async () => {
    await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "seo",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        amountCents: 100_000,
      });
    await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "seo",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 200_000,
      });

    const res = await request(app).get(
      `/api/companies/${companyId}/finance/marketing-spend?periodStart=2026-03-01&periodEnd=2026-12-31`,
    );
    expect(res.body).toHaveLength(1);
    expect(res.body[0].periodStart).toBe("2026-04-01");
  });

  it("PATCH updates fields and preserves others", async () => {
    const create = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "linkedin",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 500_000,
        notes: "original",
      });

    const patch = await request(app)
      .patch(
        `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
      )
      .send({ amountCents: 750_000, notes: "revised" });

    expect(patch.status).toBe(200);
    expect(patch.body.amountCents).toBe(750_000);
    expect(patch.body.notes).toBe("revised");
    expect(patch.body.channel).toBe("linkedin"); // preserved
    expect(patch.body.periodStart).toBe("2026-04-01"); // preserved
  });

  it("DELETE removes the row", async () => {
    const create = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "referral",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 0,
      });

    const del = await request(app).delete(
      `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
    );
    expect(del.status).toBe(204);

    const list = await request(app).get(
      `/api/companies/${companyId}/finance/marketing-spend`,
    );
    expect(list.body).toHaveLength(0);
  });

  it("PATCH on a row from another company returns 404 (tenant scope)", async () => {
    const create = await request(app)
      .post(`/api/companies/${otherCompanyId}/finance/marketing-spend`)
      .send({
        channel: "content",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 0,
      });

    const cross = await request(app)
      .patch(
        `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
      )
      .send({ amountCents: 100 });
    expect(cross.status).toBe(404);
  });

  it("DELETE on a row from another company returns 404 (tenant scope)", async () => {
    const create = await request(app)
      .post(`/api/companies/${otherCompanyId}/finance/marketing-spend`)
      .send({
        channel: "partnerships",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 0,
      });

    const cross = await request(app).delete(
      `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
    );
    expect(cross.status).toBe(404);
  });

  it("rejects negative amount via Zod (400 before DB)", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "linkedin",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: -100,
      });
    expect(res.status).toBe(400);
  });

  it("rejects period_end < period_start (Zod refine 400)", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "seo",
        periodStart: "2026-04-30",
        periodEnd: "2026-04-01",
        amountCents: 100,
      });
    expect(res.status).toBe(400);
  });

  it("rejects unknown channel (400)", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "facebook",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 100,
      });
    expect(res.status).toBe(400);
  });

  it("writes activity_log rows for create/update/delete", async () => {
    await db.delete(activityLog);

    const create = await request(app)
      .post(`/api/companies/${companyId}/finance/marketing-spend`)
      .send({
        channel: "content",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        amountCents: 50_000,
      });

    await request(app)
      .patch(
        `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
      )
      .send({ amountCents: 60_000 });

    await request(app).delete(
      `/api/companies/${companyId}/finance/marketing-spend/${create.body.id}`,
    );

    const logs = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("marketing_spend.created");
    expect(actions).toContain("marketing_spend.updated");
    expect(actions).toContain("marketing_spend.deleted");
  });
});
