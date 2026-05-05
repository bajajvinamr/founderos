/**
 * integration-health.test.ts — integration tests for connector health + KPI freshness
 *
 * Covers:
 *   1. GET /api/integrations/health — never_connected when no row
 *   2. GET /api/integrations/health — connected state (lastSyncStatus: "ok")
 *   3. GET /api/integrations/health — failed state (lastSyncStatus: "fail" + consecutiveFailures > 0)
 *   4. GET /api/integrations/health — syncing state
 *   5. GET /api/integrations/health — all 6 sources always present in response
 *   6. GET /api/integrations/health — retryAvailable only true for failed
 *   7. GET /api/companies/:id/kpi-freshness — nulls for disconnected sources
 *   8. GET /api/companies/:id/kpi-freshness — object with sourceLastSync for connected
 *   9. Auth: 401 for unauthenticated, 403 for wrong company, 400 for missing companyId
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, composioConnections, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { integrationHealthRoutes } from "../routes/integration-health.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping integration-health tests: ${support.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("Integration Health API", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-integration-health-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Wipe connections and companies between each test for isolation
    await db.execute(sql`TRUNCATE TABLE "composio_connections" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Corp" })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = buildApp({ companyIds: [companyId], ...overrides });
    app.use("/api", integrationHealthRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // ── never_connected (no DB row) ───────────────────────────────────────────

  it("returns never_connected for all 6 sources when no connections exist", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(6);

    const sources = (res.body as Array<{ source: string; status: string }>).map((r) => r.source);
    expect(sources).toEqual(["stripe", "posthog", "linkedin", "notion", "slack", "hubspot"]);

    for (const item of res.body as Array<{ status: string; lastSync: null; lastError: null; retryAvailable: boolean }>) {
      expect(item.status).toBe("never_connected");
      expect(item.lastSync).toBeNull();
      expect(item.lastError).toBeNull();
      expect(item.retryAvailable).toBe(false);
    }
  });

  // ── connected state ───────────────────────────────────────────────────────

  it("returns connected status for a source with lastSyncStatus: ok", async () => {
    const syncedAt = new Date("2026-05-01T10:00:00Z");
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "stripe",
      composioConnectionId: "ext-stripe-123",
      status: "active",
      lastSyncAt: syncedAt,
      lastSyncStatus: "ok",
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    const stripe = (res.body as Array<{ source: string; status: string; lastSync: string | null; retryAvailable: boolean }>)
      .find((r) => r.source === "stripe");
    expect(stripe).toBeDefined();
    expect(stripe!.status).toBe("connected");
    expect(stripe!.lastSync).toBe(syncedAt.toISOString());
    expect(stripe!.retryAvailable).toBe(false);
  });

  it("returns connected for lastSyncStatus: partial", async () => {
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "hubspot",
      composioConnectionId: "ext-hubspot-456",
      status: "active",
      lastSyncAt: new Date(),
      lastSyncStatus: "partial",
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    const hubspot = (res.body as Array<{ source: string; status: string }>)
      .find((r) => r.source === "hubspot");
    expect(hubspot!.status).toBe("connected");
  });

  // ── failed state ──────────────────────────────────────────────────────────

  it("returns failed and retryAvailable:true when consecutiveFailures > 0", async () => {
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "posthog",
      composioConnectionId: "ext-posthog-789",
      status: "active",
      lastSyncAt: new Date("2026-05-01T08:00:00Z"),
      lastSyncStatus: "fail",
      lastError: "API rate limit exceeded",
      consecutiveFailures: 3,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    const posthog = (res.body as Array<{ source: string; status: string; lastError: string | null; retryAvailable: boolean }>)
      .find((r) => r.source === "posthog");
    expect(posthog).toBeDefined();
    expect(posthog!.status).toBe("failed");
    expect(posthog!.lastError).toBe("API rate limit exceeded");
    expect(posthog!.retryAvailable).toBe(true);
  });

  it("returns failed when lastSyncStatus is fail even with zero consecutiveFailures", async () => {
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "notion",
      composioConnectionId: "ext-notion-000",
      status: "active",
      lastSyncStatus: "fail",
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    const notion = (res.body as Array<{ source: string; status: string }>)
      .find((r) => r.source === "notion");
    expect(notion!.status).toBe("failed");
  });

  // ── syncing state ─────────────────────────────────────────────────────────

  it("returns syncing status when lastSyncStatus is syncing", async () => {
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "slack",
      composioConnectionId: "ext-slack-sync",
      status: "active",
      lastSyncStatus: "syncing",
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    const slack = (res.body as Array<{ source: string; status: string; retryAvailable: boolean }>)
      .find((r) => r.source === "slack");
    expect(slack!.status).toBe("syncing");
    expect(slack!.retryAvailable).toBe(false);
  });

  // ── all 6 sources always present ──────────────────────────────────────────

  it("returns exactly 6 items even when only some sources have rows", async () => {
    // Insert only stripe and posthog
    await db.insert(composioConnections).values([
      {
        companyId,
        userId: "user-test",
        appName: "stripe",
        composioConnectionId: "ext-stripe-partial",
        status: "active",
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
      },
      {
        companyId,
        userId: "user-test",
        appName: "posthog",
        composioConnectionId: "ext-posthog-partial",
        status: "active",
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(200);

    expect(res.body).toHaveLength(6);

    const bySource = Object.fromEntries(
      (res.body as Array<{ source: string; status: string }>).map((r) => [r.source, r]),
    );
    expect(bySource["stripe"]!.status).toBe("connected");
    expect(bySource["posthog"]!.status).toBe("connected");
    expect(bySource["linkedin"]!.status).toBe("never_connected");
    expect(bySource["notion"]!.status).toBe("never_connected");
    expect(bySource["slack"]!.status).toBe("never_connected");
    expect(bySource["hubspot"]!.status).toBe("never_connected");
  });

  // ── KPI freshness ─────────────────────────────────────────────────────────

  it("kpi-freshness returns null for all KPIs when no connections", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/kpi-freshness`)
      .expect(200);

    const body = res.body as {
      mrr: null; arr: null; signups: null; pipeline: null; burn: null; runway: null;
    };
    expect(body.mrr).toBeNull();
    expect(body.arr).toBeNull();
    expect(body.signups).toBeNull();
    expect(body.pipeline).toBeNull();
    expect(body.burn).toBeNull();
    expect(body.runway).toBeNull();
  });

  it("kpi-freshness returns sourceLastSync object when stripe is connected", async () => {
    const syncedAt = new Date("2026-05-01T12:00:00Z");
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "stripe",
      composioConnectionId: "ext-stripe-fresh",
      status: "active",
      lastSyncAt: syncedAt,
      lastSyncStatus: "ok",
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/kpi-freshness`)
      .expect(200);

    const body = res.body as {
      mrr: { sourceLastSync: string } | null;
      arr: { sourceLastSync: string } | null;
      burn: { sourceLastSync: string } | null;
      runway: { sourceLastSync: string } | null;
      signups: null;
      pipeline: null;
    };
    // stripe backs mrr, arr, burn, runway
    expect(body.mrr).toEqual({ sourceLastSync: syncedAt.toISOString() });
    expect(body.arr).toEqual({ sourceLastSync: syncedAt.toISOString() });
    expect(body.burn).toEqual({ sourceLastSync: syncedAt.toISOString() });
    expect(body.runway).toEqual({ sourceLastSync: syncedAt.toISOString() });
    // posthog (signups) and hubspot (pipeline) not connected
    expect(body.signups).toBeNull();
    expect(body.pipeline).toBeNull();
  });

  it("kpi-freshness returns null sourceLastSync when sync never ran", async () => {
    await db.insert(composioConnections).values({
      companyId,
      userId: "user-test",
      appName: "hubspot",
      composioConnectionId: "ext-hubspot-nosync",
      status: "active",
      // lastSyncAt intentionally null — OAuth complete, no sync yet
      consecutiveFailures: 0,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/kpi-freshness`)
      .expect(200);

    const body = res.body as { pipeline: { sourceLastSync: null } | null };
    // hubspot is connected (row exists) → non-null object, but sync never ran
    expect(body.pipeline).toEqual({ sourceLastSync: null });
  });

  // ── Auth guards ───────────────────────────────────────────────────────────

  it("GET /integrations/health returns 401 for unauthenticated request", async () => {
    const app = buildApp({ type: "none" });
    app.use("/api", integrationHealthRoutes(db));
    app.use(errorHandler);

    await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(401);
  });

  it("GET /integrations/health returns 400 when companyId query param is missing", async () => {
    const app = makeApp();
    await request(app)
      .get("/api/integrations/health")
      .expect(400);
  });

  it("GET /integrations/health returns 403 when company not in actor companyIds", async () => {
    const app = buildApp({
      type: "board",
      userId: "user-other",
      companyIds: ["other-company-uuid"],
      source: "session",
      isInstanceAdmin: false,
    });
    app.use("/api", integrationHealthRoutes(db));
    app.use(errorHandler);

    await request(app)
      .get(`/api/integrations/health?companyId=${companyId}`)
      .expect(403);
  });

  it("GET /companies/:id/kpi-freshness returns 401 for unauthenticated", async () => {
    const app = buildApp({ type: "none" });
    app.use("/api", integrationHealthRoutes(db));
    app.use(errorHandler);

    await request(app)
      .get(`/api/companies/${companyId}/kpi-freshness`)
      .expect(401);
  });
});
