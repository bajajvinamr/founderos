/**
 * Sprint 6 · S6.1 — permissions matrix integration tests.
 *
 * Validates that the matrix endpoint correctly composes:
 *   - workspace_departments.autonomyLevel (per-company default)
 *   - workflows.autonomyLevel (per-workflow override)
 *   - instance_settings.general["lifecycle_crm.allow_autonomous_email"]
 *   - departments catalogue (every dept appears, even with no workflows)
 *
 * Covers:
 *   1. Empty workspace → all depts present, zero workflows, default=2
 *   2. Workflow with autonomy === dept default → source: "inherited"
 *   3. Workflow with autonomy !== dept default → source: "override"
 *   4. Master switch reflects instance_settings flag
 *   5. Tenant isolation — workflows from another company aren't leaked
 *   6. Auth — agent from another company → 403
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  departments,
  instanceSettings,
  workflows,
  workspaceDepartments,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { permissionsMatrixRoutes } from "../routes/permissions-matrix.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping permissions-matrix tests: ${support.reason ?? "unsupported"}`,
  );
}

function buildApp(actorOverrides: Record<string, unknown> = {}) {
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
  return app;
}

describeEmbeddedPostgres("permissions matrix", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("permissions-matrix");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "workflows" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "workspace_departments" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "instance_settings" CASCADE`);

    // Seed dept catalogue (idempotent — onConflictDoNothing).
    // Mirrors migration 0075 which seeds all 7 (5 core + 2 non-core).
    await db
      .insert(departments)
      .values([
        { id: "chief-of-staff", label: "Chief of Staff", sortOrder: 1, isCore: true, icon: "users" },
        { id: "growth",         label: "Growth",         sortOrder: 2, isCore: true, icon: "trending-up" },
        { id: "content",        label: "Content Studio", sortOrder: 3, isCore: true, icon: "feather" },
        { id: "crm",            label: "CRM & Lifecycle",sortOrder: 4, isCore: true, icon: "users-2" },
        { id: "finance",        label: "Finance",        sortOrder: 5, isCore: true, icon: "dollar-sign" },
        { id: "engineering",    label: "Engineering",    sortOrder: 6, isCore: false, icon: "code" },
        { id: "ops",            label: "Operations",     sortOrder: 7, isCore: false, icon: "settings" },
      ])
      .onConflictDoNothing();

    const [c] = await db
      .insert(companies)
      .values({
        name: "Permissions Test Co",
        instanceId: "test-instance",
        issuePrefix: `PM${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      })
      .returning();
    companyId = c.id;

    // Backfill workspace_departments at autonomyLevel=2 (default).
    const allDepts = await db.select({ id: departments.id }).from(departments);
    if (allDepts.length > 0) {
      await db
        .insert(workspaceDepartments)
        .values(
          allDepts.map((d) => ({
            companyId,
            departmentId: d.id,
            enabled: true,
            autonomyLevel: 2,
          })),
        )
        .onConflictDoNothing();
    }
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = buildApp({ companyIds: [companyId], ...overrides });
    app.use("/api", permissionsMatrixRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("empty workspace → matrix has all depts, no workflows, default=2", async () => {
    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    expect(res.body.companyId).toBe(companyId);
    expect(res.body.autonomousMasterSwitch).toBe(false);
    expect(Array.isArray(res.body.departments)).toBe(true);
    // 7 catalogued depts seeded above (5 core + 2 non-core)
    expect(res.body.departments).toHaveLength(7);
    for (const dept of res.body.departments) {
      expect(dept.deptAutonomy).toBe(2);
      expect(dept.workflows).toEqual([]);
    }
  });

  it("departments are returned in sortOrder", async () => {
    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    const ids = res.body.departments.map((d: { id: string }) => d.id);
    expect(ids).toEqual([
      "chief-of-staff",
      "growth",
      "content",
      "crm",
      "finance",
      "engineering",
      "ops",
    ]);
  });

  it("dept autonomy override propagates to deptAutonomy", async () => {
    await db
      .update(workspaceDepartments)
      .set({ autonomyLevel: 3 })
      .where(sql`department_id = 'crm' AND company_id = ${companyId}`);

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    const crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.deptAutonomy).toBe(3);
    const growth = res.body.departments.find((d: { id: string }) => d.id === "growth");
    expect(growth.deptAutonomy).toBe(2);
  });

  it("workflow with autonomy=deptDefault → source: inherited", async () => {
    await db.insert(workflows).values({
      companyId,
      name: "Onboarding email blast",
      template: "onboarding-emails",
      triggerKind: "event",
      triggerSpec: { source: "stripe", event: "customer.created" },
      autonomyLevel: 2, // matches dept default
    });

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    const crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows).toHaveLength(1);
    expect(crm.workflows[0].source).toBe("inherited");
    expect(crm.workflows[0].autonomy).toBe(2);
    expect(crm.workflows[0].name).toBe("Onboarding email blast");
  });

  it("workflow with autonomy != deptDefault → source: override", async () => {
    await db.insert(workflows).values({
      companyId,
      name: "Activation nudge",
      template: "activation-nudge",
      triggerKind: "schedule",
      triggerSpec: { cron: "0 9 * * *" },
      autonomyLevel: 3, // overrides dept default of 2
    });

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    const crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows).toHaveLength(1);
    expect(crm.workflows[0].source).toBe("override");
    expect(crm.workflows[0].autonomy).toBe(3);
  });

  it("source recomputes when dept default changes", async () => {
    await db.insert(workflows).values({
      companyId,
      name: "Churn rescue",
      template: "churn-rescue",
      triggerKind: "schedule",
      triggerSpec: { cron: "0 9 * * *" },
      autonomyLevel: 3,
    });

    // First read: dept=2, wf=3 → override
    let res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);
    let crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows[0].source).toBe("override");

    // Bump dept default to 3 to match workflow.
    await db
      .update(workspaceDepartments)
      .set({ autonomyLevel: 3 })
      .where(sql`department_id = 'crm' AND company_id = ${companyId}`);

    // Second read: dept=3, wf=3 → inherited (lazy recompute)
    res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);
    crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows[0].source).toBe("inherited");
  });

  it("master switch reflects instance_settings flag", async () => {
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: { "lifecycle_crm.allow_autonomous_email": true },
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { general: { "lifecycle_crm.allow_autonomous_email": true } },
      });

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    expect(res.body.autonomousMasterSwitch).toBe(true);
  });

  it("master switch defaults to false when settings row absent", async () => {
    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    expect(res.body.autonomousMasterSwitch).toBe(false);
  });

  // Note: We can't insert an "unknown template" because the DB CHECK
  // constraint workflows_template_check enforces the closed enum at the
  // SQL layer. The "_uncategorized" bucket exists for the case where the
  // DB enum admits a template that the dept-map hasn't picked up yet
  // (e.g., during a mid-deploy where the CHECK was migrated but the
  // map wasn't shipped). Since we can't simulate that without breaking
  // the constraint, we verify map coverage instead: every template in
  // WORKFLOW_TEMPLATES MUST have a dept assignment.
  it("every CHECK-allowed template is in the dept map (no orphans)", async () => {
    // The 4 templates the CHECK allows today.
    const allowed = ["onboarding-emails", "activation-nudge", "churn-rescue", "upsell"];

    for (const tpl of allowed) {
      await db.insert(workflows).values({
        companyId,
        name: `Workflow for ${tpl}`,
        template: tpl as "onboarding-emails" | "activation-nudge" | "churn-rescue" | "upsell",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "test.event" },
        autonomyLevel: 2,
      });
    }

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    // Every workflow lands under "crm" with current map.
    const crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows).toHaveLength(4);
    // No phantom _uncategorized bucket should appear in the response.
    const ids = res.body.departments.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("_uncategorized");
  });

  it("tenant isolation — other company's workflows aren't surfaced", async () => {
    // Create a second company and add a workflow to it.
    const [other] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: "OO",
      })
      .returning();
    await db.insert(workflows).values({
      companyId: other.id,
      name: "Their workflow",
      template: "churn-rescue",
      triggerKind: "schedule",
      triggerSpec: { cron: "0 9 * * *" },
      autonomyLevel: 3,
    });

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    for (const dept of res.body.departments) {
      expect(dept.workflows).toHaveLength(0);
    }
  });

  it("agent from another company is rejected (403)", async () => {
    const otherActorApp = buildApp({
      type: "agent",
      agentId: "agent-other",
      companyId: "different-company-id",
    });
    otherActorApp.use("/api", permissionsMatrixRoutes(db));
    otherActorApp.use(errorHandler);

    await request(otherActorApp)
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(403);
  });

  it("multiple workflows under one dept are all returned", async () => {
    await db.insert(workflows).values([
      {
        companyId,
        name: "Onboarding emails",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "customer.created" },
        autonomyLevel: 2,
      },
      {
        companyId,
        name: "Churn rescue",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        autonomyLevel: 3,
      },
      {
        companyId,
        name: "Upsell flow",
        template: "upsell",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "subscription.upgraded" },
        autonomyLevel: 2,
      },
    ]);

    const res = await request(makeApp())
      .get(`/api/companies/${companyId}/permissions-matrix`)
      .expect(200);

    const crm = res.body.departments.find((d: { id: string }) => d.id === "crm");
    expect(crm.workflows).toHaveLength(3);
    expect(new Set(crm.workflows.map((w: { name: string }) => w.name))).toEqual(
      new Set(["Onboarding emails", "Churn rescue", "Upsell flow"]),
    );
  });
});
