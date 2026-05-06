/**
 * Sprint 6 · S6.2 — approval engine refinement integration tests.
 *
 * Validates:
 *   1. Migration 0098 — approvals.workflow_run_id column exists, FK works,
 *      ON DELETE SET NULL preserves the approval row.
 *   2. Approval creation accepts workflowRunId in payload and persists.
 *   3. Listing/getting an approval returns workflowRunId.
 *   4. POST /approvals/:id/approve with promoteWorkflowToAutonomous=true
 *      AND linked workflowRun AND instance master switch ON
 *      → workflow.autonomyLevel becomes 4
 *   5. Same call with master switch OFF
 *      → workflow.autonomyLevel stays unchanged
 *      → audit log entry approval.autonomy_promotion_blocked
 *   6. Same call without workflowRunId is a no-op (no error).
 *   7. Cross-tenant guard — approval pointing at another company's
 *      workflow_run does NOT promote that workflow.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  createDb,
  instanceSettings,
  workflowRuns,
  workflows,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping approvals-workflow-link tests: ${support.reason ?? "unsupported"}`,
  );
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
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("approvals workflow link (S6.2)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let workflowId: string;
  let workflowRunId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("approvals-workflow-link");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "approvals" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "workflow_runs" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "workflows" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "agents" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "instance_settings" CASCADE`);

    const [c] = await db
      .insert(companies)
      .values({
        name: "Approvals S6.2 Co",
        instanceId: "test-instance",
        issuePrefix: `AP${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      })
      .returning();
    companyId = c.id;

    const [wf] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Test workflow",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        autonomyLevel: 3, // approval-required (the realistic starting point)
      })
      .returning();
    workflowId = wf.id;

    const [run] = await db
      .insert(workflowRuns)
      .values({
        workflowId,
        companyId,
        status: "pending_approval",
        triggeredBy: { kind: "manual", actorId: "test" },
        actions: [],
      })
      .returning();
    workflowRunId = run.id;
  });

  // ── Schema correctness ────────────────────────────────────────────────────

  it("creates an approval with a linked workflow_run_id", async () => {
    const app = buildApp(db, { companyIds: [companyId] });

    const res = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "hire_agent",
        payload: { name: "Test", role: "growth" },
        workflowRunId,
      })
      .expect(201);

    expect(res.body.workflowRunId).toBe(workflowRunId);

    const [persisted] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, res.body.id))
      .limit(1);
    expect(persisted.workflowRunId).toBe(workflowRunId);
  });

  it("workflow_run_id is nullable for non-workflow approvals", async () => {
    const app = buildApp(db, { companyIds: [companyId] });

    const res = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "budget_override_required",
        payload: { amount: 1000 },
        // no workflowRunId
      })
      .expect(201);

    expect(res.body.workflowRunId).toBeNull();
  });

  it("ON DELETE SET NULL — deleting workflow_run nulls the approval link", async () => {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        workflowRunId,
      })
      .returning();

    await db.delete(workflowRuns).where(eq(workflowRuns.id, workflowRunId));

    const [survivor] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .limit(1);
    expect(survivor).toBeDefined();
    expect(survivor.workflowRunId).toBeNull();
  });

  // ── Approve + promoteWorkflowToAutonomous behavior ─────────────────────────

  it("promote with master switch ON → workflow autonomy bumps to 4", async () => {
    // Master switch ON
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { "lifecycle_crm.allow_autonomous_email": true },
    });

    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        workflowRunId,
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ promoteWorkflowToAutonomous: true })
      .expect(200);

    const [wfAfter] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    expect(wfAfter.autonomyLevel).toBe(4);
  });

  it("promote with master switch OFF → autonomy unchanged + audit entry", async () => {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        workflowRunId,
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ promoteWorkflowToAutonomous: true })
      .expect(200);

    const [wfAfter] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    // Stays at 3 (the pre-existing level); no silent promotion.
    expect(wfAfter.autonomyLevel).toBe(3);

    // Activity log should contain the blocked event.
    const activityLog = await db.execute(
      sql`SELECT action FROM "activity_log" WHERE entity_id = ${approval.id} ORDER BY created_at DESC`,
    );
    const rows = "rows" in activityLog ? activityLog.rows : (activityLog as unknown as Array<{ action: string }>);
    const actions = (rows as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain("approval.autonomy_promotion_blocked");
  });

  it("promote without workflowRunId is a no-op (no error)", async () => {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        // no workflowRunId
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ promoteWorkflowToAutonomous: true })
      .expect(200);

    // No error; workflow autonomy unchanged because there's no link.
    const [wfAfter] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    expect(wfAfter.autonomyLevel).toBe(3);
  });

  it("approve without promote flag does not bump autonomy", async () => {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { "lifecycle_crm.allow_autonomous_email": true },
    });

    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        workflowRunId,
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({}) // no promoteWorkflowToAutonomous
      .expect(200);

    const [wfAfter] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);
    expect(wfAfter.autonomyLevel).toBe(3);
  });

  // ── Cross-tenant guard ─────────────────────────────────────────────────────

  it("cross-tenant guard — approval cannot promote another company's workflow", async () => {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: { "lifecycle_crm.allow_autonomous_email": true },
    });

    // Create a 2nd company + workflow + workflow_run that "leaks" via the
    // approval's workflowRunId pointing at it.
    const [other] = await db
      .insert(companies)
      .values({
        name: "Victim Co",
        instanceId: "test-instance",
        issuePrefix: "VC",
      })
      .returning();
    const [otherWf] = await db
      .insert(workflows)
      .values({
        companyId: other.id,
        name: "Victim workflow",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        autonomyLevel: 2, // not yet autonomous
      })
      .returning();
    const [otherRun] = await db
      .insert(workflowRuns)
      .values({
        workflowId: otherWf.id,
        companyId: other.id,
        status: "pending_approval",
        triggeredBy: { kind: "manual", actorId: "test" },
        actions: [],
      })
      .returning();

    // Attacker's approval — their own company, but workflowRunId points at
    // the victim. (Real production would reject this at the create step too,
    // but we're testing the defense-in-depth at the approve path.)
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId, // attacker company
        type: "hire_agent",
        status: "pending",
        payload: {},
        workflowRunId: otherRun.id, // points at victim
      })
      .returning();

    const app = buildApp(db, { companyIds: [companyId] });
    await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ promoteWorkflowToAutonomous: true })
      .expect(200);

    // Victim workflow MUST NOT have been promoted.
    const [victimAfter] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, otherWf.id))
      .limit(1);
    expect(victimAfter.autonomyLevel).toBe(2);
  });
});
