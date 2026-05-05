/**
 * department-status.test.ts — integration tests for the Department Status
 * rollup endpoint (S3.4).
 *
 * Covers (per ticket):
 *   1. healthy department (agent + heartbeat, no errors, < 5 approvals)
 *      → green
 *   2. errored agent (agentRuntimeState.lastRunStatus='error') → red
 *   3. > 5 pending approvals → red
 *   4. open kpi_anomaly insight with severity='critical' → red
 *   5. > 2 stalled workflows (routines.status='paused') → yellow
 *   6. last activity > 24h ago → yellow
 *   7. department with no agents → grey
 *
 * Real embedded Postgres so the JSONB filter on insights.evidence,
 * the FK CASCADE, and the runtime_state join all run end-to-end.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  approvals,
  companies,
  createDb,
  insights,
  routines,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { departmentStatusRoutes } from "../routes/department-status.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping department-status tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Department Status API (S3.4)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("dept-status");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // CASCADE wipes children — explicit truncate ordering keeps the failure
    // mode obvious if a future migration drops a CASCADE.
    await db.execute(sql`TRUNCATE TABLE "agent_runtime_state" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "approvals" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "routines" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "agents" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Dept Status Co" })
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
    app.use("/api", departmentStatusRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // Helper: insert an agent with optional runtime state overrides.
  async function seedAgent(opts: {
    role: string;
    status?: string;
    lastHeartbeatAt?: Date | null;
    lastRunStatus?: string | null;
    runtimeUpdatedAt?: Date;
  }): Promise<string> {
    const [a] = await db
      .insert(agents)
      .values({
        companyId,
        name: `agent-${opts.role}`,
        role: opts.role,
        status: opts.status ?? "idle",
        lastHeartbeatAt: opts.lastHeartbeatAt ?? null,
      })
      .returning({ id: agents.id });
    const agentId = a!.id;

    // Always seed runtime state — the rollup reads lastRunStatus from there.
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "claude_local",
      lastRunStatus: opts.lastRunStatus ?? "ok",
      ...(opts.runtimeUpdatedAt ? { updatedAt: opts.runtimeUpdatedAt } : {}),
    });

    return agentId;
  }

  // ── (1) healthy → green ───────────────────────────────────────────────

  it("(1) returns green for a healthy department", async () => {
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["chief-of-staff"].health).toBe("green");
    expect(res.body["chief-of-staff"].agentCount).toBe(1);
    expect(res.body["chief-of-staff"].pendingApprovals).toBe(0);
    expect(res.body["chief-of-staff"].openInsights).toBe(0);
    expect(res.body["chief-of-staff"].stalledWorkflows).toBe(0);
  });

  // ── (2) errored agent → red ───────────────────────────────────────────

  it("(2) returns red when an agent has runtime state lastRunStatus='error'", async () => {
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "error",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["chief-of-staff"].health).toBe("red");
  });

  // ── (3) > 5 pending approvals → red ───────────────────────────────────

  it("(3) returns red when pendingApprovals > 5", async () => {
    const agentId = await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    // Insert 6 pending approvals all attributed to the CoS agent.
    await db.insert(approvals).values(
      Array.from({ length: 6 }, (_, i) => ({
        companyId,
        type: "approve_strategy",
        requestedByAgentId: agentId,
        status: "pending",
        payload: { idx: i },
      })),
    );

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["chief-of-staff"].pendingApprovals).toBe(6);
    expect(res.body["chief-of-staff"].health).toBe("red");
  });

  // ── (4) critical kpi_anomaly insight → red ────────────────────────────

  it("(4) returns red when an open critical kpi_anomaly insight exists", async () => {
    await seedAgent({
      role: "cmo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    await db.insert(insights).values({
      companyId,
      department: "growth",
      kind: "kpi_anomaly",
      title: "Conversion crash",
      body: "MQL → SQL conversion fell 60% week over week.",
      confidence: 0.9,
      evidence: { severity: "critical", deltaPct: -0.6 },
      status: "open",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["growth"].health).toBe("red");
    expect(res.body["growth"].openInsights).toBe(1);

    // A non-critical anomaly should NOT trigger red.
    await db.insert(insights).values({
      companyId,
      department: "finance",
      kind: "kpi_anomaly",
      title: "Burn drift",
      body: "x",
      confidence: 0.6,
      evidence: { severity: "warning" },
      status: "open",
    });
    await seedAgent({
      role: "cfo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    const res2 = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);
    expect(res2.body["finance"].health).toBe("green");
    expect(res2.body["finance"].openInsights).toBe(1);
  });

  // ── (5) > 2 stalled workflows → yellow ────────────────────────────────

  it("(5) returns yellow when > 2 routines are paused (stalled workflows)", async () => {
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    await db.insert(routines).values([
      { companyId, title: "r1", status: "paused" },
      { companyId, title: "r2", status: "paused" },
      { companyId, title: "r3", status: "paused" },
      // active routine should not count
      { companyId, title: "r4", status: "active" },
    ]);

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["chief-of-staff"].stalledWorkflows).toBe(3);
    expect(res.body["chief-of-staff"].health).toBe("yellow");
  });

  // ── (6) last activity > 24h ago → yellow ──────────────────────────────

  it("(6) returns yellow when last activity is stale (>24h)", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: stale,
      lastRunStatus: "ok",
      runtimeUpdatedAt: stale,
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["chief-of-staff"].health).toBe("yellow");
    // lastActivity is the ISO of the heartbeat (or runtime updatedAt — both
    // are stale, max() lands on the same instant).
    expect(res.body["chief-of-staff"].lastActivity).not.toBeNull();
  });

  // ── (7) no agents → grey ──────────────────────────────────────────────

  it("(7) returns grey for a department with no agents", async () => {
    // Seed only a CoS agent; CRM has no roles in the map → grey.
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(200);

    expect(res.body["crm"].health).toBe("grey");
    expect(res.body["crm"].agentCount).toBe(0);
  });

  // ── auth: cross-tenant access denied ──────────────────────────────────

  it("rejects access when actor lacks companyId membership", async () => {
    await seedAgent({
      role: "ceo",
      lastHeartbeatAt: new Date(),
      lastRunStatus: "ok",
    });

    // Build app with an actor whose companyIds do NOT include companyId.
    const app = buildApp({ companyIds: ["00000000-0000-0000-0000-000000000000"] });
    await request(app)
      .get(`/api/companies/${companyId}/department-status`)
      .expect(403);
  });
});
