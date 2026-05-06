/**
 * churn-rescue-e2e.test.ts — S4.8 demo path end-to-end.
 *
 * Drives the COMPLETE pipeline in a single test:
 *
 *   triggerChurnRescue (#192-#199 composed)
 *     → workflow_run row inserted with pre-stamped actions
 *     → executeChurnRescueTemplate dispatched
 *       → per-recipient suppression check
 *       → CAN-SPAM wrapper applied
 *       → HMAC unsubscribe URL generated
 *       → email shipped via capture transport
 *     → workflow_run.status = "completed"
 *     → activity_log row written
 *
 * No mocks, no stubs — embedded Postgres + capture transport. This is the
 * test the council finding #4 demands: "approval-time cohort matches
 * send-time cohort, byte-for-byte".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
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
import { executeWorkflowTemplate } from "../services/workflows.js";
import {
  getCapturedEmails,
  resetCapturedEmails,
  resetEmailTransport,
} from "../services/transports/email-transport.js";

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const APP_URL_ENV = "APP_URL";
const TEST_SECRET = "test-churn-e2e-secret-32-bytes-min-OK-padding";
const TEST_APP_URL = "https://founderos.test";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping churn-rescue-e2e tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("S4.8 churn-rescue E2E — trigger → dispatcher → transport", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let workflowId: string;
  let prevSecret: string | undefined;
  let prevAppUrl: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env[SECRET_ENV];
    prevAppUrl = process.env[APP_URL_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
    process.env[APP_URL_ENV] = TEST_APP_URL;
    testDb = await startEmbeddedPostgresTestDatabase("churn-e2e");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
    if (prevSecret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = prevSecret;
    if (prevAppUrl === undefined) delete process.env[APP_URL_ENV];
    else process.env[APP_URL_ENV] = prevAppUrl;
  });

  beforeEach(async () => {
    resetEmailTransport();
    resetCapturedEmails();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.execute(sql`TRUNCATE TABLE instance_settings CASCADE`);
    await db.execute(sql`TRUNCATE TABLE activity_log`);

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
    const [company] = await db
      .insert(companies)
      .values({
        name: "E2E Churn Co",
        instanceId: "test",
        issuePrefix: `EC${suffix}`,
        physicalAddress: "100 E2E Lane, Test, CA 94000",
        supportEmail: "ops@e2e-churn.example.com",
      })
      .returning();
    companyId = company.id;

    const [wf] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Churn rescue (E2E)",
        template: "churn-rescue",
        triggerKind: "event",
        triggerSpec: { source: "stripe", event: "customer.subscription.deleted" },
        autonomyLevel: 4,
        status: "active",
        config: {
          rescueUrl: "https://e2e-churn.example.com/billing",
          couponCode: "RESCUE25",
        },
      })
      .returning();
    workflowId = wf.id;
  });

  it("autonomous Stripe-cancellation flow ships exactly one wrapped email", async () => {
    // Phase 1 — trigger creates the workflow_run with pre-stamped actions.
    const trigger = await triggerChurnRescue(db, {
      companyId,
      workflowId,
      externalEventId: "evt_stripe_sub_deleted_42",
      candidates: [
        {
          email: "ALICE@example.com", // Test the lowercasing path
          contactName: "Alice",
          cancellationCategory: "pricing",
        },
      ],
      triggerSource: "stripe",
      triggerEvent: "customer.subscription.deleted",
    });
    expect(trigger.ok).toBe(true);
    if (!trigger.ok) return;
    expect(trigger.status).toBe("running");
    expect(trigger.actionCount).toBe(1);
    expect(trigger.idempotentReplay).toBe(false);

    // Phase 2 — fetch the run + workflow rows the dispatcher will need.
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    expect(run).toBeDefined();
    expect(workflow).toBeDefined();
    if (!run || !workflow) return;

    // Phase 3 — drive the dispatcher.
    await executeWorkflowTemplate(db, workflow, run);

    // Phase 4 — final state assertions.
    const [finalRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    expect(finalRun?.status).toBe("completed");

    const finalActions = finalRun?.actions as Array<{
      type: string;
      status: string;
      payload: Record<string, unknown>;
    }>;
    expect(finalActions).toHaveLength(1);
    expect(finalActions[0].status).toBe("completed");
    expect(finalActions[0].payload.transportMode).toBe("capture");
    expect(finalActions[0].payload.providerMessageId).toBeDefined();

    // Phase 5 — capture transport saw exactly one wrapped email.
    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    expect(sent.to).toBe("alice@example.com"); // lowercased
    expect(sent.subject).toContain("Sorry to see you go");
    // CAN-SPAM wrapper
    expect(sent.html ?? "").toContain("founderos-compliance-footer");
    expect(sent.html ?? "").toContain("100 E2E Lane");
    // HMAC unsubscribe URL
    expect(sent.html ?? "").toContain(`${TEST_APP_URL}/u/customer/`);
    // Coupon URL with query param
    expect(sent.html ?? "").toContain("coupon=RESCUE25");
    // Workflow tag for downstream observability
    expect(sent.tags).toContainEqual({
      name: "template",
      value: "churn-rescue",
    });

    // Phase 6 — activity_log captured the autonomous send.
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, finalRun!.id));
    const completionRow = activities.find(
      (r) => r.action === "churn_rescue_completed",
    );
    expect(completionRow).toBeDefined();
    expect((completionRow!.details as Record<string, unknown>).completed).toBe(1);
    expect((completionRow!.details as Record<string, unknown>).skipped).toBe(0);
    expect((completionRow!.details as Record<string, unknown>).failed).toBe(0);
  });

  it("Stripe-webhook idempotency: same event_id twice → only 1 email shipped", async () => {
    const args = {
      companyId,
      workflowId,
      externalEventId: "evt_stripe_idempotent_99",
      candidates: [
        {
          email: "bob@example.com",
          cancellationCategory: "missing_features" as const,
        },
      ],
      triggerSource: "stripe" as const,
    };

    // First webhook delivery
    const first = await triggerChurnRescue(db, args);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const [run1] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId));
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    if (!run1 || !workflow) return;
    await executeWorkflowTemplate(db, workflow, run1);

    expect(getCapturedEmails()).toHaveLength(1);

    // Second webhook delivery (Stripe retries on transient 5xx) — must
    // be a no-op replay, no second email
    const second = await triggerChurnRescue(db, args);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotentReplay).toBe(true);
    expect(second.workflowRunId).toBe(first.workflowRunId);

    // No second send fired (the replay returns the existing run unchanged;
    // the dispatcher is not invoked on replays — that's the upstream caller's
    // contract: only run executeWorkflowTemplate when idempotentReplay=false)
    expect(getCapturedEmails()).toHaveLength(1);
  });

  it("autonomy=2 + flag enabled → run parks at pending_approval, no email shipped", async () => {
    await db
      .update(workflows)
      .set({ autonomyLevel: 2 })
      .where(eq(workflows.id, workflowId));

    const trigger = await triggerChurnRescue(db, {
      companyId,
      workflowId,
      externalEventId: "evt_draft_only",
      candidates: [
        { email: "carol@example.com", cancellationCategory: "lack_of_usage" },
      ],
      triggerSource: "stripe",
    });
    expect(trigger.ok).toBe(true);
    if (!trigger.ok) return;
    expect(trigger.status).toBe("pending_approval");

    // Even if the dispatcher is fired, autonomy gate parks it again
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    if (!run || !workflow) return;
    await executeWorkflowTemplate(db, workflow, run);

    const [finalRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    expect(finalRun?.status).toBe("pending_approval");
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("suppression added between trigger and dispatch is honored at send time", async () => {
    // 1. Cohort created with two recipients
    const trigger = await triggerChurnRescue(db, {
      companyId,
      workflowId,
      externalEventId: "evt_late_suppress",
      candidates: [
        { email: "stay@example.com", cancellationCategory: "pricing" },
        { email: "leave@example.com", cancellationCategory: "pricing" },
      ],
      triggerSource: "stripe",
    });
    expect(trigger.ok).toBe(true);
    if (!trigger.ok) return;
    expect(trigger.actionCount).toBe(2);

    // 2. BETWEEN approval and send, leave@ unsubscribes via the unsubscribe
    // URL — bounce webhook etc. inserts a suppression row.
    await db.insert(customerEmailSuppressions).values({
      companyId,
      contactEmail: "leave@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: { source: "unsubscribe_link" },
    });

    // 3. Dispatcher fires. Per-recipient defense-in-depth catches the
    // late suppression.
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    if (!run || !workflow) return;
    await executeWorkflowTemplate(db, workflow, run);

    const [finalRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, trigger.workflowRunId));
    const actions = finalRun?.actions as Array<{
      payload: { recipientEmail: string };
      status: string;
    }>;

    const stayAction = actions.find(
      (a) => a.payload.recipientEmail === "stay@example.com",
    );
    const leaveAction = actions.find(
      (a) => a.payload.recipientEmail === "leave@example.com",
    );
    expect(stayAction?.status).toBe("completed");
    expect(leaveAction?.status).toBe("skipped");

    // Only one email actually shipped
    expect(getCapturedEmails()).toHaveLength(1);
    expect(getCapturedEmails()[0].to).toBe("stay@example.com");
  });
});
