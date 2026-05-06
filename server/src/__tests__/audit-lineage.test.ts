/**
 * Sprint 6 · S6.3 — audit lineage integration tests.
 *
 * Validates that GET /api/audit/:logId/lineage:
 *   - 404 when logId doesn't exist
 *   - returns the log row + workflow when log.workflowId is set
 *   - expands lineage_refs.insightIds → insights[]
 *   - expands lineage_refs.approvalIds → approvals[]
 *   - expands lineage_refs.eventIds → events[]
 *   - omits foreign-tenant insights/approvals/events (defense in depth)
 *   - returns empty arrays when lineage_refs is null
 *   - 403 when caller lacks access to the row's companyId
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  activityLog,
  approvals,
  companies,
  createDb,
  events,
  insights,
  workflows,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { auditLineageRoutes } from "../routes/audit-lineage.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping audit-lineage tests: ${support.reason ?? "unsupported"}`);
}

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: ["__placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", auditLineageRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("audit lineage (S6.3)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("audit-lineage");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "activity_log" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "approvals" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "insights" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "workflows" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [c] = await db
      .insert(companies)
      .values({
        name: "Lineage Test Co",
        instanceId: "test-instance",
        issuePrefix: `LN${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      })
      .returning();
    companyId = c.id;
  });

  it("returns 404 when logId does not exist", async () => {
    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .get("/api/audit/00000000-0000-0000-0000-000000000000/lineage")
      .expect(404);
  });

  it("returns log + null arrays when lineage_refs is null", async () => {
    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "test.action",
        entityType: "test",
        entityId: "abc",
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.log.id).toBe(log.id);
    expect(res.body.workflow).toBeNull();
    expect(res.body.workflowRun).toBeNull();
    expect(res.body.insights).toEqual([]);
    expect(res.body.approvals).toEqual([]);
    expect(res.body.events).toEqual([]);
  });

  it("expands workflow when activityLog.workflowId is set", async () => {
    const [wf] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Test workflow",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        autonomyLevel: 3,
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "workflow.activated",
        entityType: "workflow",
        entityId: wf.id,
        workflowId: wf.id,
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.workflow).toMatchObject({
      id: wf.id,
      name: "Test workflow",
      template: "churn-rescue",
      autonomyLevel: 3,
    });
  });

  it("expands lineage_refs.insightIds into insights[]", async () => {
    const [insight] = await db
      .insert(insights)
      .values({
        companyId,
        department: "growth",
        kind: "kpi_anomaly",
        title: "Signup CVR dropped 22%",
        body: "...",
        confidence: 0.85,
        evidence: {},
        status: "open",
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "agent",
        actorId: "a1",
        action: "experiment.proposed",
        entityType: "experiment",
        entityId: "exp-1",
        lineageRefs: { insightIds: [insight.id] },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.insights).toHaveLength(1);
    expect(res.body.insights[0]).toMatchObject({
      id: insight.id,
      title: "Signup CVR dropped 22%",
      kind: "kpi_anomaly",
    });
  });

  it("expands lineage_refs.approvalIds into approvals[]", async () => {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: {},
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "user",
        actorId: "u1",
        action: "agent.created",
        entityType: "agent",
        entityId: "ag-1",
        lineageRefs: { approvalIds: [approval.id] },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0]).toMatchObject({
      id: approval.id,
      type: "hire_agent",
      status: "approved",
    });
  });

  it("expands lineage_refs.eventIds into events[]", async () => {
    const [evt] = await db
      .insert(events)
      .values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `evt_${Math.random()}`,
        occurredAt: new Date(),
        payload: { subscription_id: "sub_1" },
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "system",
        actorId: "sys",
        action: "insight.created",
        entityType: "insight",
        entityId: "ins-1",
        lineageRefs: { eventIds: [evt.id] },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      id: evt.id,
      source: "stripe",
      eventName: "subscription.created",
    });
  });

  it("expands all three reference arrays in one go", async () => {
    const [insight] = await db
      .insert(insights)
      .values({
        companyId,
        department: "growth",
        kind: "kpi_anomaly",
        title: "Test",
        body: "...",
        confidence: 0.5,
        evidence: {},
        status: "open",
      })
      .returning();

    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: {},
      })
      .returning();

    const [evt] = await db
      .insert(events)
      .values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `evt_${Math.random()}`,
        occurredAt: new Date(),
        payload: {},
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "agent",
        actorId: "a1",
        action: "workflow.run.dispatched",
        entityType: "workflow_run",
        entityId: "wfr-1",
        lineageRefs: {
          insightIds: [insight.id],
          approvalIds: [approval.id],
          eventIds: [evt.id],
        },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.insights).toHaveLength(1);
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.events).toHaveLength(1);
  });

  it("foreign-tenant references are silently dropped (defense in depth)", async () => {
    // Create a 2nd company with its own insight, then craft a log row in
    // the FIRST company that references the foreign insight.
    const [other] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: "OO",
      })
      .returning();

    const [foreignInsight] = await db
      .insert(insights)
      .values({
        companyId: other.id,
        department: "growth",
        kind: "kpi_anomaly",
        title: "Foreign insight",
        body: "...",
        confidence: 0.9,
        evidence: {},
        status: "open",
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId, // OUR company
        actorType: "agent",
        actorId: "a1",
        action: "experiment.proposed",
        entityType: "experiment",
        entityId: "exp-1",
        lineageRefs: { insightIds: [foreignInsight.id] }, // foreign id
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    // The foreign insight MUST NOT be returned — tenant-scoped query
    // filters it out at the DB level.
    expect(res.body.insights).toHaveLength(0);
  });

  it("403 when caller lacks access to log's companyId", async () => {
    const [log] = await db
      .insert(activityLog)
      .values({
        companyId, // belongs to companyId
        actorType: "user",
        actorId: "u1",
        action: "test.action",
        entityType: "test",
        entityId: "x",
      })
      .returning();

    // Caller is a board member of a DIFFERENT company.
    const app = buildApp(db, { companyIds: ["different-company-id"] });
    await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(403);
  });

  it("partial lineage_refs (only one array key present) works", async () => {
    const [evt] = await db
      .insert(events)
      .values({
        companyId,
        source: "posthog",
        entityType: "event",
        eventName: "$pageview",
        dedupKey: `evt_${Math.random()}`,
        occurredAt: new Date(),
        payload: {},
      })
      .returning();

    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "system",
        actorId: "sys",
        action: "insight.created",
        entityType: "insight",
        entityId: "ins-2",
        // Only eventIds present; insightIds + approvalIds absent.
        lineageRefs: { eventIds: [evt.id] },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.events).toHaveLength(1);
    expect(res.body.insights).toEqual([]);
    expect(res.body.approvals).toEqual([]);
  });

  it("missing referenced ids return empty (e.g., row was deleted)", async () => {
    const [log] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "agent",
        actorId: "a1",
        action: "test.action",
        entityType: "test",
        entityId: "x",
        lineageRefs: {
          insightIds: ["00000000-0000-0000-0000-000000000000"],
        },
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    const res = await request(app)
      .get(`/api/audit/${log.id}/lineage`)
      .expect(200);

    expect(res.body.insights).toEqual([]);
  });
});
