/**
 * workflow-runs-idempotency.test.ts
 *
 * Tests for idempotency_key deduplication in workflow_runs.
 * Council 2026-05-06 S4.8 prerequisite #2.
 *
 * Spec:
 *   - G1: createWorkflowRun without idempotencyKey → row created, no conflict
 *   - G2: Two creates with same (companyId, workflowId, idempotencyKey) → only 1 row
 *   - G3: Same key but DIFFERENT workflowIds → 2 rows (composite-scoped)
 *   - G4: Same key but DIFFERENT companyIds → 2 rows (tenancy preserved)
 *   - G5: Concurrent creates with same key → exactly 1 row (race-safe)
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startEmbeddedPostgresTestDatabase, createDb, companies } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import { createWorkflowRun, createWorkflow } from "../services/workflows.js";
import type { Db } from "@founderos/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping workflow_runs idempotency tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow_runs idempotency", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let workflowId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workflow-idempotency-test-");
    db = createDb(tempDb.connectionString);

    // Create test company
    const [company] = await db
      .insert(companies)
      .values({
        name: "Test Company",
        slug: `test-${Date.now()}`,
        plan: "pro",
      })
      .returning();
    if (!company) throw new Error("Company insert failed");
    companyId = company.id;

    // Create test workflow
    const workflow = await createWorkflow(db, {
      companyId,
      actorType: "system",
      actorId: "test",
      data: {
        name: "Test Workflow",
        template: "churn-rescue",
        triggerKind: "event",
        triggerSpec: { event: "test" },
      },
    });
    workflowId = workflow.id;
  }, 20_000);

  afterEach(async () => {
    // Clean up workflow_runs for the next test
    const { workflowRuns } = await import("@founderos/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(workflowRuns).where(eq(workflowRuns.companyId, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("G1: createWorkflowRun without idempotencyKey → row created, no conflict", async () => {
    const run = await createWorkflowRun(db, {
      companyId,
      workflowId,
      actorType: "system",
      actorId: "test",
      data: {
        status: "running",
        triggeredBy: { kind: "manual", actorId: "test" },
      },
    });

    expect(run).toBeDefined();
    expect(run.idempotencyKey).toBeNull();
  });

  it("G2: Two creates with same (companyId, workflowId, idempotencyKey) → only 1 row", async () => {
    const key = "test-key-1";

    const run1 = await createWorkflowRun(db, {
      companyId,
      workflowId,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "event", eventId: "evt1", eventName: "test" },
      },
    });

    const run2 = await createWorkflowRun(db, {
      companyId,
      workflowId,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "event", eventId: "evt2", eventName: "test" },
      },
    });

    // Both should return the same run (second is a no-op insert + re-query)
    expect(run1.id).toBe(run2.id);
    expect(run1.idempotencyKey).toBe(key);
    expect(run2.idempotencyKey).toBe(key);
  });

  it("G3: Same key but DIFFERENT workflowIds → 2 rows (composite-scoped)", async () => {
    // Create a second workflow
    const workflow2 = await createWorkflow(db, {
      companyId,
      actorType: "system",
      actorId: "test",
      data: {
        name: "Test Workflow 2",
        template: "onboarding-emails",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 0 * * *" },
      },
    });

    const key = "shared-key";

    const run1 = await createWorkflowRun(db, {
      companyId,
      workflowId,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "manual", actorId: "test" },
      },
    });

    const run2 = await createWorkflowRun(db, {
      companyId,
      workflowId: workflow2.id,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "manual", actorId: "test" },
      },
    });

    // Different workflows → different rows
    expect(run1.id).not.toBe(run2.id);
    expect(run1.workflowId).not.toBe(run2.workflowId);
  });

  it("G4: Same key but DIFFERENT companyIds → 2 rows (tenancy preserved)", async () => {
    // Create a second company
    const company2Id = randomUUID();
    const uniqueSuffix = randomUUID().slice(0, 6).toUpperCase();
    const [company2] = await db
      .insert(companies)
      .values({
        id: company2Id,
        name: "Test Company 2",
        issuePrefix: `T2${uniqueSuffix}`,
        plan: "pro",
      })
      .returning();
    if (!company2) throw new Error("Company 2 insert failed");

    // Create workflow in second company
    const workflow2 = await createWorkflow(db, {
      companyId: company2.id,
      actorType: "system",
      actorId: "test",
      data: {
        name: "Test Workflow",
        template: "churn-rescue",
        triggerKind: "event",
        triggerSpec: { event: "test" },
      },
    });

    const key = "shared-key";

    const run1 = await createWorkflowRun(db, {
      companyId,
      workflowId,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "manual", actorId: "test" },
      },
    });

    const run2 = await createWorkflowRun(db, {
      companyId: company2.id,
      workflowId: workflow2.id,
      actorType: "system",
      actorId: "test",
      idempotencyKey: key,
      data: {
        status: "running",
        triggeredBy: { kind: "manual", actorId: "test" },
      },
    });

    // Different companies → different rows
    expect(run1.id).not.toBe(run2.id);
    expect(run1.companyId).not.toBe(run2.companyId);
  });

  it("G5: Concurrent creates with same key → exactly 1 row (race-safe)", async () => {
    const key = "concurrent-key";

    // Fire two concurrent creates with the same key
    const [run1, run2] = await Promise.all([
      createWorkflowRun(db, {
        companyId,
        workflowId,
        actorType: "system",
        actorId: "test",
        idempotencyKey: key,
        data: {
          status: "running",
          triggeredBy: { kind: "event", eventId: "evt1", eventName: "test" },
        },
      }),
      createWorkflowRun(db, {
        companyId,
        workflowId,
        actorType: "system",
        actorId: "test",
        idempotencyKey: key,
        data: {
          status: "running",
          triggeredBy: { kind: "event", eventId: "evt2", eventName: "test" },
        },
      }),
    ]);

    // Both should return the same run ID (dedup by DB constraint)
    expect(run1.id).toBe(run2.id);
    expect(run1.idempotencyKey).toBe(key);
  });
});
