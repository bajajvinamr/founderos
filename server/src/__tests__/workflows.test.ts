/**
 * workflows.test.ts — integration tests for the Lifecycle CRM workflow registry
 * (S4.5, council-flagged #154).
 *
 * Test categories and coverage intent:
 *
 *   A. Basic CRUD (4 tests)
 *      A1. POST creates workflow with correct defaults
 *      A2. GET list returns workflow; filters by status; meta.total is correct
 *      A3. GET single returns workflow; 404 on missing
 *      A4. PATCH updates name/config; emits audit log
 *
 *   B. RBAC + tenant isolation (4 tests) — council focus area
 *      B1. Cross-tenant read: company A actor cannot read company B workflows
 *      B2. Cross-tenant mutation: company A actor cannot PATCH company B workflow
 *      B3. Agent token cannot activate a workflow (board-only endpoint)
 *      B4. Unauthenticated request returns 401
 *
 *   C. Autonomy gate (4 tests) — council focus area
 *      C1. New workflow defaults autonomyLevel=2 (draft) when not specified
 *      C2. autonomyLevel=4 without instance flag → 409 conflict
 *      C3. autonomyLevel=4 with instance flag set → 201 created
 *      C4. PATCH to autonomyLevel=4 without instance flag → 409
 *
 *   D. Workflow runs (3 tests)
 *      D1. POST /runs creates run with status="running" for autonomy<3
 *      D2. POST /runs creates run with status="pending_approval" for autonomy=3
 *      D3. POST /runs on paused workflow → 400
 *
 *   E. DB-level CHECK constraints (2 tests)
 *      E1. CHECK on workflows.status rejects invalid value via raw SQL
 *      E2. CHECK on workflow_runs.status rejects invalid value via raw SQL
 *
 *   F. Drizzle and() invariant (1 test)
 *      F1. Two-filter query (status + template) narrows correctly, proving
 *          .where(and(...)) is composing both predicates.
 *
 * Total: 18 tests.
 *
 * All tests use real embedded Postgres — CHECK constraints, FK CASCADE, and
 * composite FK enforcement are only verifiable against the real DDL.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, workflows, workflowRuns } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { AUTONOMOUS_EMAIL_SETTING_KEY } from "../services/workflow-autonomy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping workflow tests: ${support.reason ?? "unsupported environment"}`);
}

// ── Shared test app builder ──────────────────────────────────────────────────

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
  companyIds?: string[],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-test",
      companyIds: companyIds ?? ["__placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

/**
 * Minimal valid workflow body. Tests that only care about one field override
 * just what they need.
 */
function validWorkflowBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Onboarding sequence",
    template: "onboarding-emails",
    triggerKind: "event",
    triggerSpec: { source: "posthog", event: "identify" },
    ...overrides,
  };
}

/** Enable the autonomous email instance flag directly in the DB. */
async function enableAutonomousEmail(db: ReturnType<typeof createDb>) {
  // instance_settings has a singleton_key row; we upsert the flag.
  await db.execute(sql`
    INSERT INTO "instance_settings" ("singleton_key", "general")
    VALUES ('default', ${JSON.stringify({ [AUTONOMOUS_EMAIL_SETTING_KEY]: true })}::jsonb)
    ON CONFLICT ("singleton_key") DO UPDATE
      SET "general" = "instance_settings"."general" || ${JSON.stringify({ [AUTONOMOUS_EMAIL_SETTING_KEY]: true })}::jsonb
  `);
}

/** Disable the autonomous email instance flag. */
async function disableAutonomousEmail(db: ReturnType<typeof createDb>) {
  await db.execute(sql`
    INSERT INTO "instance_settings" ("singleton_key", "general")
    VALUES ('default', '{}'::jsonb)
    ON CONFLICT ("singleton_key") DO UPDATE
      SET "general" = "instance_settings"."general" - ${AUTONOMOUS_EMAIL_SETTING_KEY}
  `);
}

// ── Test suite ───────────────────────────────────────────────────────────────

describeEmbeddedPostgres("Workflow Registry API (S4.5)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-workflows-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Cascade wipes workflow_runs and workflows via FK ON DELETE CASCADE.
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "instance_settings" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Acme Corp", issuePrefix: "ACM" })
      .returning({ id: companies.id });
    companyId = company!.id;

    const [other] = await db
      .insert(companies)
      .values({ name: "Other Corp", issuePrefix: "OTH" })
      .returning({ id: companies.id });
    otherCompanyId = other!.id;
  });

  // ════════════════════════════════════════════════════════════════════════
  // A. Basic CRUD
  // ════════════════════════════════════════════════════════════════════════

  it("A1. POST creates workflow with correct defaults", async () => {
    const app = buildApp(db, {}, [companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody())
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.name).toBe("Onboarding sequence");
    expect(res.body.template).toBe("onboarding-emails");
    // Autonomy default must be 2 (draft), not 4 (autonomous).
    expect(res.body.autonomyLevel).toBe(2);
    expect(res.body.status).toBe("draft");
  });

  it("A2. GET list returns workflows; status filter works; meta.total is correct", async () => {
    const app = buildApp(db, {}, [companyId]);

    // Create two workflows with different statuses.
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ name: "Draft WF", status: "draft" }))
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ name: "Active WF", status: "active" }))
      .expect(201);

    // Unfiltered — returns both.
    const all = await request(app)
      .get(`/api/companies/${companyId}/workflows`)
      .expect(200);
    expect(all.body.workflows).toHaveLength(2);
    expect(all.body.meta.total).toBe(2);

    // Filter to active only — returns one.
    const active = await request(app)
      .get(`/api/companies/${companyId}/workflows?status=active`)
      .expect(200);
    expect(active.body.workflows).toHaveLength(1);
    expect(active.body.workflows[0].name).toBe("Active WF");
    expect(active.body.meta.total).toBe(1);
  });

  it("A3. GET single returns workflow; 404 on unknown id", async () => {
    const app = buildApp(db, {}, [companyId]);

    const created = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody())
      .expect(201);

    const fetched = await request(app)
      .get(`/api/companies/${companyId}/workflows/${created.body.id}`)
      .expect(200);
    expect(fetched.body.id).toBe(created.body.id);

    await request(app)
      .get(`/api/companies/${companyId}/workflows/00000000-0000-0000-0000-000000000000`)
      .expect(404);
  });

  it("A4. PATCH updates name and config; returns updated row", async () => {
    const app = buildApp(db, {}, [companyId]);

    const created = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody())
      .expect(201);

    const patched = await request(app)
      .patch(`/api/companies/${companyId}/workflows/${created.body.id}`)
      .send({ name: "Renamed WF", config: { emailDelay: 2 } })
      .expect(200);

    expect(patched.body.name).toBe("Renamed WF");
    expect(patched.body.config).toMatchObject({ emailDelay: 2 });
  });

  // ════════════════════════════════════════════════════════════════════════
  // B. RBAC + tenant isolation
  // ════════════════════════════════════════════════════════════════════════

  it("B1. Cross-tenant read: company A actor cannot read company B workflows", async () => {
    // Insert a workflow belonging to otherCompanyId directly (bypassing the API).
    await db.insert(workflows).values({
      companyId: otherCompanyId,
      name: "Other co workflow",
      template: "churn-rescue",
      triggerKind: "manual",
      triggerSpec: {},
      autonomyLevel: 2,
      status: "draft",
      config: {},
    });

    // Actor is only a member of companyId (Acme Corp), not otherCompanyId.
    const app = buildApp(db, {}, [companyId]);

    // Attempting to read otherCompanyId's workflow list → 403.
    await request(app)
      .get(`/api/companies/${otherCompanyId}/workflows`)
      .expect(403);
  });

  it("B2. Cross-tenant mutation: company A actor cannot PATCH company B workflow", async () => {
    // Insert a workflow in otherCompanyId.
    const [otherWf] = await db
      .insert(workflows)
      .values({
        companyId: otherCompanyId,
        name: "Other workflow",
        template: "upsell",
        triggerKind: "manual",
        triggerSpec: {},
        autonomyLevel: 2,
        status: "draft",
        config: {},
      })
      .returning({ id: workflows.id });

    // Actor only belongs to companyId — trying to PATCH via other company's path → 403.
    const app = buildApp(db, {}, [companyId]);

    await request(app)
      .patch(`/api/companies/${otherCompanyId}/workflows/${otherWf!.id}`)
      .send({ name: "Hijacked" })
      .expect(403);

    // Verify name unchanged in DB.
    const [check] = await db
      .select()
      .from(workflows)
      .where(sql`"id" = ${otherWf!.id}`);
    expect(check!.name).toBe("Other workflow");
  });

  it("B3. Agent token cannot activate a workflow (board-only endpoint)", async () => {
    const app = buildApp(db, {
      type: "agent",
      agentId: "agent-123",
      companyId,
    });

    // First create a workflow via a board app.
    const boardApp = buildApp(db, {}, [companyId]);
    const created = await request(boardApp)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody())
      .expect(201);

    // Agent tries to activate — 403 (assertBoard rejects agent type).
    await request(app)
      .post(`/api/companies/${companyId}/workflows/${created.body.id}/activate`)
      .expect(403);
  });

  it("B4. Unauthenticated request returns 401", async () => {
    // Actor type "none" = unauthenticated.
    const app = buildApp(db, { type: "none" });

    await request(app)
      .get(`/api/companies/${companyId}/workflows`)
      .expect(401);
  });

  // ════════════════════════════════════════════════════════════════════════
  // C. Autonomy gate
  // ════════════════════════════════════════════════════════════════════════

  it("C1. New workflow defaults autonomyLevel=2 when not specified", async () => {
    const app = buildApp(db, {}, [companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({
        name: "Default autonomy WF",
        template: "activation-nudge",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        // autonomyLevel intentionally omitted — must default to 2
      })
      .expect(201);

    // DB default AND Zod schema default must both produce 2.
    expect(res.body.autonomyLevel).toBe(2);
  });

  it("C2. autonomyLevel=4 without instance flag → 409 conflict", async () => {
    // Ensure flag is absent.
    await disableAutonomousEmail(db);

    const app = buildApp(db, {}, [companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ autonomyLevel: 4 }))
      .expect(409);

    expect(res.body.error).toMatch(/lifecycle_crm\.allow_autonomous_email/);
  });

  it("C3. autonomyLevel=4 with instance flag enabled → 201 created", async () => {
    await enableAutonomousEmail(db);

    const app = buildApp(db, {}, [companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ autonomyLevel: 4 }))
      .expect(201);

    expect(res.body.autonomyLevel).toBe(4);
  });

  it("C4. PATCH to autonomyLevel=4 without instance flag → 409", async () => {
    await disableAutonomousEmail(db);

    const app = buildApp(db, {}, [companyId]);

    const created = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ autonomyLevel: 2 }))
      .expect(201);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/workflows/${created.body.id}`)
      .send({ autonomyLevel: 4 })
      .expect(409);

    expect(res.body.error).toMatch(/lifecycle_crm\.allow_autonomous_email/);

    // Verify autonomyLevel unchanged in DB.
    const [check] = await db
      .select()
      .from(workflows)
      .where(sql`"id" = ${created.body.id}`);
    expect(check!.autonomyLevel).toBe(2);
  });

  // ════════════════════════════════════════════════════════════════════════
  // D. Workflow runs
  // ════════════════════════════════════════════════════════════════════════

  it("D1. POST /runs creates run with status=running for autonomyLevel<3", async () => {
    const app = buildApp(db, {}, [companyId]);

    // Create an active workflow with autonomy=2.
    const wf = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ status: "active", autonomyLevel: 2 }))
      .expect(201);

    const run = await request(app)
      .post(`/api/companies/${companyId}/workflows/${wf.body.id}/runs`)
      .send({ triggeredBy: { kind: "manual" } })
      .expect(201);

    expect(run.body.status).toBe("running");
    expect(run.body.workflowId).toBe(wf.body.id);
    expect(run.body.companyId).toBe(companyId);
  });

  it("D2. POST /runs creates run with status=pending_approval for autonomyLevel=3", async () => {
    const app = buildApp(db, {}, [companyId]);

    const wf = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ status: "active", autonomyLevel: 3 }))
      .expect(201);

    const run = await request(app)
      .post(`/api/companies/${companyId}/workflows/${wf.body.id}/runs`)
      .send({ triggeredBy: { kind: "event", eventId: "evt-123", eventName: "identify" } })
      .expect(201);

    // Autonomy=3 → must pause for human approval.
    expect(run.body.status).toBe("pending_approval");
  });

  it("D3. POST /runs on paused workflow → 400", async () => {
    const app = buildApp(db, {}, [companyId]);

    const wf = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send(validWorkflowBody({ status: "paused" }))
      .expect(201);

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows/${wf.body.id}/runs`)
      .send({ triggeredBy: { kind: "manual" } })
      .expect(400);

    expect(res.body.error).toMatch(/paused/);
  });

  // ════════════════════════════════════════════════════════════════════════
  // E. DB-level CHECK constraints (raw SQL bypasses TS types)
  // ════════════════════════════════════════════════════════════════════════

  it("E1. CHECK constraint rejects invalid workflow status via raw SQL", async () => {
    // Use the companyId from beforeEach — avoids the issue_prefix unique constraint
    // violation that would occur from inserting a third company (all default to 'PAP').
    const [company] = await db
      .insert(companies)
      .values({ name: "Check Test Co", issuePrefix: "CHK" })
      .returning({ id: companies.id });

    await expect(
      db.execute(sql`
        INSERT INTO "workflows"
          ("company_id","name","template","trigger_kind","trigger_spec","autonomy_level","status","config")
        VALUES
          (${company!.id},'x','onboarding-emails','manual','{}',2,'NOT_REAL_STATUS','{}')
      `),
    ).rejects.toThrow(/workflows_status_check|check constraint/i);
  });

  it("E2. CHECK constraint rejects invalid workflow_run status via raw SQL", async () => {
    // Need a valid workflow first.
    const [company] = await db
      .insert(companies)
      .values({ name: "Check Run Test Co", issuePrefix: "CRN" })
      .returning({ id: companies.id });

    const [wf] = await db
      .insert(workflows)
      .values({
        companyId: company!.id,
        name: "test",
        template: "upsell",
        triggerKind: "manual",
        triggerSpec: {},
        autonomyLevel: 2,
        status: "active",
        config: {},
      })
      .returning({ id: workflows.id });

    await expect(
      db.execute(sql`
        INSERT INTO "workflow_runs"
          ("workflow_id","company_id","status","triggered_by","actions")
        VALUES
          (${wf!.id},${company!.id},'INVALID_STATUS','{"kind":"manual"}','[]')
      `),
    ).rejects.toThrow(/workflow_runs_status_check|check constraint/i);
  });

  // ════════════════════════════════════════════════════════════════════════
  // F. Drizzle and() invariant
  // ════════════════════════════════════════════════════════════════════════

  it("F1. Two-filter list (status + template) narrows correctly — and() invariant", async () => {
    const app = buildApp(db, {}, [companyId]);

    // Insert 3 workflows: different combinations of status + template.
    await db.insert(workflows).values([
      {
        companyId,
        name: "A",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: {},
        autonomyLevel: 2,
        status: "active",
        config: {},
      },
      {
        companyId,
        name: "B",
        template: "churn-rescue",
        triggerKind: "manual",
        triggerSpec: {},
        autonomyLevel: 2,
        status: "active",
        config: {},
      },
      {
        companyId,
        name: "C",
        template: "onboarding-emails",
        triggerKind: "schedule",
        triggerSpec: {},
        autonomyLevel: 2,
        status: "draft",
        config: {},
      },
    ]);

    // status=active AND template=onboarding-emails → should return only A.
    // If .where() were chained (bug), the template filter would REPLACE status
    // and return A + C (both onboarding-emails regardless of status).
    const res = await request(app)
      .get(`/api/companies/${companyId}/workflows?status=active&template=onboarding-emails`)
      .expect(200);

    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].name).toBe("A");
    expect(res.body.meta.total).toBe(1);
  });

  // ── G. Dispatcher invocation (W0.1 council 2026-05-05 BLOCK fix) ───────────

  it("G1. POST /runs actually dispatches executeWorkflowTemplate (not just creates row)", async () => {
    // The 2026-05-05 council found: routes/workflows.ts created the run row
    // and returned 201 immediately, but executeWorkflowTemplate was only
    // called from tests — never from the live route handler. Founder UI
    // showed "succeeded" without any template execution. This test is the
    // contract: POSTing to /runs must cause the dispatcher to fire.
    //
    // Observable signal: run.status moves OFF "running" after setImmediate
    // flush. The dispatched executor (template handler OR error catch) is
    // the only code path that updates the status post-creation.
    const app = buildApp(db, {}, [companyId]);

    const [w] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Dispatcher contract test",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: {},
        autonomyLevel: 2, // draft — template gates real sends; status still moves
        status: "active",
        config: {},
      })
      .returning();

    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows/${w!.id}/runs`)
      .send({ triggeredBy: { kind: "manual" } })
      .expect(201);

    expect(res.body.status).toBe("running"); // route returns row pre-dispatch

    // Wait for setImmediate to flush + the dispatcher's await chain to settle.
    // 300ms is generous for embedded-pg + the onboarding-emails template
    // path which does at most a couple of DB writes before updating status.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const [persistedRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, res.body.id));

    expect(persistedRun).toBeDefined();
    // The dispatcher MUST have moved the status off "running" — either to
    // completed (template succeeded), failed (template threw + setRunStatus
    // catch), or pending_approval (template gated). The exact terminal state
    // depends on template behavior; what this test asserts is dispatch fired.
    expect(persistedRun!.status).not.toBe("running");
  });
});
