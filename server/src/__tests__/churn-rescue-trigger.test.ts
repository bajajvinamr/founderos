/**
 * churn-rescue-trigger.test.ts — S4.8 end-to-end orchestrator integration.
 *
 * Drives `triggerChurnRescue` against a real DB and verifies every prereq
 * fires in composition. No mocks — the dispatcher template runs separately
 * (covered in churn-rescue.test.ts); this file's scope is the CREATE-time
 * pipeline only.
 *
 * Coverage:
 *   1.  Workflow not found → ok=false, reason=workflow_not_found
 *   2.  Workflow with wrong template → ok=false
 *   3.  Workflow paused → ok=false, reason=workflow_paused
 *   4.  Empty cohort → ok=false, reason=empty_cohort
 *   5.  All-invalid candidates → ok=false, reason=all_recipients_dropped
 *   6.  Happy path: 1 candidate, autonomy=4, flag enabled → status=running
 *   7.  Happy path: 1 candidate, autonomy=2 → status=pending_approval
 *   8.  Idempotency: same externalEventId twice → second is replay no-op
 *   9.  Rate limit: ≥50 prior runs in 24h for churn-rescue → cap hit
 *  10.  Suppression mid-cohort: dropped recipient counted, others ship
 *  11.  Connected account stamping: when stripe connection exists,
 *       actions[*].payload.connectedAccountId is set
 *  12.  No connection → connectedAccountId omitted (NOT throws)
 *  13.  Cross-tenant: companyB's workflowId rejected when invoked under A
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  companies,
  composioConnections,
  createDb,
  customerEmailSuppressions,
  instanceSettings,
  workflowRuns,
  workflows,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { triggerChurnRescue } from "../services/workflows/templates/churn-rescue-trigger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping churn-rescue-trigger tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("S4.8 churn-rescue trigger orchestrator", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;
  let workflowAId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("churn-trigger");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.execute(sql`TRUNCATE TABLE instance_settings CASCADE`);

    // Enable autonomous email flag at instance level
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: { "lifecycle_crm.allow_autonomous_email": true },
        experimental: {},
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { general: { "lifecycle_crm.allow_autonomous_email": true } },
      });

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [a] = await db
      .insert(companies)
      .values({
        name: "Co A",
        instanceId: "test",
        issuePrefix: `TA${suffix}`,
        physicalAddress: "100 Test St",
        supportEmail: "support@a.example.com",
      })
      .returning();
    const [b] = await db
      .insert(companies)
      .values({
        name: "Co B",
        instanceId: "test",
        issuePrefix: `TB${suffix}`,
        physicalAddress: "200 Other St",
      })
      .returning();
    companyAId = a.id;
    companyBId = b.id;

    const [wf] = await db
      .insert(workflows)
      .values({
        companyId: companyAId,
        name: "Churn rescue",
        template: "churn-rescue",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "customer.subscription.deleted" },
        autonomyLevel: 4,
        status: "active",
        config: { rescueUrl: "https://a.io/billing", couponCode: "RESCUE25" },
      })
      .returning();
    workflowAId = wf.id;
  });

  // ── 1-3. Validation failures ─────────────────────────────────────────────

  it("returns workflow_not_found when workflowId doesn't match the tenant", async () => {
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: "00000000-0000-0000-0000-000000000000",
      externalEventId: "evt_1",
      candidates: [{ email: "x@example.com", cancellationCategory: "pricing" }],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("workflow_not_found");
  });

  it("rejects a workflow with the wrong template", async () => {
    const [wrong] = await db
      .insert(workflows)
      .values({
        companyId: companyAId,
        name: "Onboarding",
        template: "onboarding-emails",
        triggerKind: "event",
        triggerSpec: { source: "posthog", event: "identify" },
        autonomyLevel: 4,
        status: "active",
        config: {},
      })
      .returning();
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: wrong.id,
      externalEventId: "evt_1",
      candidates: [{ email: "x@example.com", cancellationCategory: "pricing" }],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("workflow_wrong_template");
  });

  it("rejects a paused workflow", async () => {
    await db
      .update(workflows)
      .set({ status: "paused" })
      .where(eq(workflows.id, workflowAId));
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_paused",
      candidates: [{ email: "x@example.com", cancellationCategory: "pricing" }],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("workflow_paused");
  });

  // ── 4-5. Empty / all-dropped cohort ──────────────────────────────────────

  it("returns empty_cohort when candidates is empty", async () => {
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_empty",
      candidates: [],
      triggerSource: "scheduler",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_cohort");
  });

  it("returns all_recipients_dropped when every candidate has invalid email", async () => {
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_garbage",
      candidates: [
        { email: "not-an-email", cancellationCategory: "pricing" },
        { email: "another@bad", cancellationCategory: "other" },
      ],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_recipients_dropped");
  });

  // ── 6-7. Autonomy → initial status ───────────────────────────────────────

  it("creates a running run when autonomy=4 + flag enabled", async () => {
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_running",
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "stripe",
      triggerEvent: "customer.subscription.deleted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("running");
    expect(result.actionCount).toBe(1);
    expect(result.idempotentReplay).toBe(false);

    // Verify the row was actually persisted
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.workflowRunId));
    expect(run?.status).toBe("running");
    expect(run?.idempotencyKey).toBe("evt_running");
    expect((run?.actions as unknown[]).length).toBe(1);
  });

  it("creates a pending_approval run when autonomy<4", async () => {
    await db
      .update(workflows)
      .set({ autonomyLevel: 2 })
      .where(eq(workflows.id, workflowAId));
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_pending",
      candidates: [{ email: "x@example.com", cancellationCategory: "pricing" }],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("pending_approval");
  });

  // ── 8. Idempotency ───────────────────────────────────────────────────────

  it("idempotent replay: same externalEventId twice = same run, second is replay", async () => {
    const args = {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_dup",
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" as const },
      ],
      triggerSource: "stripe" as const,
    };
    const first = await triggerChurnRescue(db, args);
    const second = await triggerChurnRescue(db, args);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.workflowRunId).toBe(first.workflowRunId);
    expect(second.idempotentReplay).toBe(true);
    expect(first.idempotentReplay).toBe(false);

    // Only ONE row in the DB
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.idempotencyKey, "evt_dup"));
    expect(rows).toHaveLength(1);
  });

  // ── 9. Rate limit ────────────────────────────────────────────────────────

  it("rejects when daily cap is exceeded", async () => {
    // Seed 50 prior runs (the default cap) — assertWorkflowRunRateLimit
    // checks COUNT >= cap and throws. Each row needs a unique idempotency
    // key (UNIQUE NULLS NOT DISTINCT on companyId+workflowId+key).
    const seeds = Array.from({ length: 50 }, (_, i) => ({
      companyId: companyAId,
      workflowId: workflowAId,
      status: "completed" as const,
      triggeredBy: { kind: "event" as const },
      actions: [],
      idempotencyKey: `seed-cap-${i}`,
    }));
    await db.insert(workflowRuns).values(seeds);

    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_overcap",
      candidates: [{ email: "x@example.com", cancellationCategory: "pricing" }],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rate_limit_exceeded");
  });

  // ── 10. Suppression in cohort ────────────────────────────────────────────

  it("counts suppressed candidates, ships the rest", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId: companyAId,
      contactEmail: "blocked@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_mixed",
      candidates: [
        { email: "blocked@example.com", cancellationCategory: "pricing" },
        { email: "ok@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "scheduler",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actionCount).toBe(1);
    expect(result.counts.droppedSuppressed).toBe(1);
    expect(result.counts.candidates).toBe(2);
    expect(result.counts.materialized).toBe(1);
  });

  // ── 11-12. Composio account stamping ─────────────────────────────────────

  it("stamps connectedAccountId on actions when an active stripe connection exists", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "local-user",
      appName: "stripe",
      composioConnectionId: "ca_stripe_123",
      status: "active",
      authConfigId: "auth_cfg_stripe",
    });
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_stamp",
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.workflowRunId));
    const actions = run!.actions as Array<{
      payload: { connectedAccountId?: string };
    }>;
    expect(actions[0].payload.connectedAccountId).toBe("ca_stripe_123");
  });

  it("omits connectedAccountId when no active stripe connection exists", async () => {
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: workflowAId,
      externalEventId: "evt_noconn",
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.workflowRunId));
    const actions = run!.actions as Array<{
      payload: { connectedAccountId?: string };
    }>;
    expect(actions[0].payload.connectedAccountId).toBeUndefined();
  });

  // ── 13. Cross-tenant ─────────────────────────────────────────────────────

  it("rejects company A's invocation against company B's workflowId", async () => {
    const [wfB] = await db
      .insert(workflows)
      .values({
        companyId: companyBId,
        name: "B Churn",
        template: "churn-rescue",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "customer.subscription.deleted" },
        autonomyLevel: 4,
        status: "active",
        config: {},
      })
      .returning();

    // Caller claims company A but sends company B's workflowId — defense
    // in depth via the (id, companyId) WHERE clause.
    const result = await triggerChurnRescue(db, {
      companyId: companyAId,
      workflowId: wfB.id,
      externalEventId: "evt_cross",
      candidates: [
        { email: "alice@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "stripe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("workflow_not_found");
  });
});
