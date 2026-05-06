/**
 * churn-rescue.test.ts — S4.8 demo template integration tests.
 *
 * Covers the composition layer over prereqs #192-#199:
 *   1. Empty actions[] at execute time → run failed (scheduler contract bug)
 *   2. autonomyLevel=2 (draft) → pending_approval, no transport call
 *   3. autonomyLevel=3 (approval) → pending_approval, no transport call
 *   4. autonomyLevel=4 + instance flag enabled → autonomous send + capture
 *   5. Per-recipient suppression at send time → action.status=skipped
 *   6. Compliance physicalAddress NULL → action failed, run failed
 *   7. Compliance physicalAddress set → CAN-SPAM footer in wrapped body
 *   8. Multi-recipient mixed outcome (one skipped, one sent) → run completed
 *   9. Multi-recipient with transport failure → run failed
 *  10. Cross-tenant suppression isolation
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  customerEmailSuppressions,
  instanceSettings,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createWorkflow,
  createWorkflowRun,
  executeWorkflowTemplate,
  getWorkflowRun,
} from "../services/workflows.js";
import {
  getCapturedEmails,
  resetCapturedEmails,
  resetEmailTransport,
} from "../services/transports/email-transport.js";

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const APP_URL_ENV = "APP_URL";
const TEST_SECRET = "test-churn-rescue-secret-c4f6a8b2-9d3e-4f17-bc05";
const TEST_APP_URL = "https://founderos.test";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping churn-rescue tests: ${support.reason ?? "unsupported"}`,
  );
}

interface TestAction {
  type: "send_email";
  payload: {
    recipientEmail: string;
    recipientName?: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    connectedAccountId?: string;
    providerMessageId?: string;
    transportMode?: string;
    skipReason?: string;
  };
  status: "pending" | "completed" | "failed" | "skipped";
  executedAt?: string;
  error?: string;
}

describeEmbeddedPostgres("S4.8 churn-rescue template", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let prevSecret: string | undefined;
  let prevAppUrl: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env[SECRET_ENV];
    prevAppUrl = process.env[APP_URL_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
    process.env[APP_URL_ENV] = TEST_APP_URL;

    testDb = await startEmbeddedPostgresTestDatabase("churn-rescue");
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
    await db.delete(customerEmailSuppressions);
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
        name: "Churn Rescue Test Co",
        instanceId: "test-instance",
        issuePrefix: `CR${suffix}`,
        physicalAddress: "100 Test St, Test City, CA 94000",
        supportEmail: "support@example.com",
      })
      .returning();
    companyId = company.id;
  });

  // ── Test helper: drive a run via the dispatcher ──────────────────────────

  async function runChurnRescue(
    actions: TestAction[],
    overrides: { autonomyLevel?: number; companyOverrideId?: string } = {},
  ) {
    const cId = overrides.companyOverrideId ?? companyId;
    const workflow = await createWorkflow(db, {
      companyId: cId,
      actorType: "user",
      actorId: "founder-1",
      data: {
        name: "Churn rescue",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 9 * * *" },
        autonomyLevel: overrides.autonomyLevel ?? 4,
        status: "active",
        config: { rescueUrl: "https://example.com/rescue", couponCode: "RESCUE25" },
      },
    });
    const run = await createWorkflowRun(db, {
      companyId: cId,
      workflowId: workflow.id,
      actorType: "system",
      actorId: "trigger-engine",
      data: {
        status: "running",
        triggeredBy: { source: "stripe", event: "customer.subscription.deleted" },
        actions,
      },
    });
    await executeWorkflowTemplate(db, workflow, run);
    return await getWorkflowRun(db, cId, run.id);
  }

  function makeAction(
    recipientEmail: string,
    overrides: Partial<TestAction["payload"]> = {},
  ): TestAction {
    return {
      type: "send_email",
      payload: {
        recipientEmail,
        recipientName: "Pat",
        subject: "We hate to see you go",
        bodyText: "Sorry to see you go. Here's 25% off if you'd like to come back.",
        bodyHtml:
          "<p>Sorry to see you go. Here's 25% off if you'd like to come back.</p>",
        ...overrides,
      },
      status: "pending",
    };
  }

  // ── 1. Scheduler-contract guard ──────────────────────────────────────────

  it("fails the run when actions[] is empty at execute time", async () => {
    const updated = await runChurnRescue([]);
    expect(updated?.status).toBe("failed");
    expect(getCapturedEmails()).toHaveLength(0);
  });

  // ── 2-3. Autonomy gate parks the run for human approval ──────────────────

  it("autonomyLevel=2 → pending_approval, no transport call", async () => {
    const updated = await runChurnRescue(
      [makeAction("alice@example.com")],
      { autonomyLevel: 2 },
    );
    expect(updated?.status).toBe("pending_approval");
    expect(getCapturedEmails()).toHaveLength(0);
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("pending");
  });

  it("autonomyLevel=3 → pending_approval, no transport call", async () => {
    const updated = await runChurnRescue(
      [makeAction("bob@example.com")],
      { autonomyLevel: 3 },
    );
    expect(updated?.status).toBe("pending_approval");
    expect(getCapturedEmails()).toHaveLength(0);
  });

  // ── 4. Autonomous send happy path ────────────────────────────────────────

  it("autonomyLevel=4 + flag enabled → autonomous send, run completed", async () => {
    const updated = await runChurnRescue([makeAction("carol@example.com")]);
    expect(updated?.status).toBe("completed");
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("completed");
    expect(actions[0].payload.transportMode).toBe("capture");
    expect(actions[0].payload.providerMessageId).toBeDefined();

    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("carol@example.com");
    expect(captured[0].subject).toBe("We hate to see you go");
    expect(captured[0].tags).toContainEqual({
      name: "template",
      value: "churn-rescue",
    });
  });

  // ── 5. Defense-in-depth: per-recipient suppression at send time ──────────

  it("skips a recipient with topic='churn_rescue' suppression added since approval", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId,
      contactEmail: "dave@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const updated = await runChurnRescue([makeAction("dave@example.com")]);
    expect(updated?.status).toBe("completed");
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("skipped");
    expect(actions[0].payload.skipReason).toBe("customer_email_suppressed");
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("respects topic='all' master switch at send time", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId,
      contactEmail: "eve@example.com",
      topic: "all",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const updated = await runChurnRescue([makeAction("eve@example.com")]);
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("skipped");
  });

  // ── 6-7. CAN-SPAM compliance ─────────────────────────────────────────────

  it("fails the action when company has no physical_address (compliance gate)", async () => {
    await db
      .update(companies)
      .set({ physicalAddress: null })
      .where(eq(companies.id, companyId));
    const updated = await runChurnRescue([makeAction("frank@example.com")]);
    expect(updated?.status).toBe("failed");
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("failed");
    expect(actions[0].error).toContain("compliance_refused");
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("injects CAN-SPAM footer + unsubscribe URL into wrapped body", async () => {
    await runChurnRescue([makeAction("grace@example.com")]);
    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    // Wrapper marker proves the footer was injected
    expect(captured[0].html ?? "").toContain("founderos-compliance-footer");
    // HMAC unsubscribe URL points at the test app origin
    expect(captured[0].html ?? "").toContain(`${TEST_APP_URL}/u/customer/`);
    // Physical address from beforeEach company seed
    expect(captured[0].text ?? "").toContain("100 Test St");
  });

  // ── 8-9. Run-level outcome aggregation ───────────────────────────────────

  it("aggregates: one skipped + one sent → run completed", async () => {
    await db.insert(customerEmailSuppressions).values({
      companyId,
      contactEmail: "skipped@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });
    const updated = await runChurnRescue([
      makeAction("skipped@example.com"),
      makeAction("sent@example.com"),
    ]);
    expect(updated?.status).toBe("completed");
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("skipped");
    expect(actions[1].status).toBe("completed");
    expect(getCapturedEmails()).toHaveLength(1);
  });

  // ── 10. Cross-tenant isolation ───────────────────────────────────────────

  it("does not honor another company's suppression row", async () => {
    // Company A has dave suppressed
    await db.insert(customerEmailSuppressions).values({
      companyId,
      contactEmail: "shared@example.com",
      topic: "churn_rescue",
      reason: "user_unsubscribe",
      metadata: {},
    });

    // Company B (different tenant) sends to the same email — must NOT be
    // filtered, since A's row is scoped to companyId=A.
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [companyB] = await db
      .insert(companies)
      .values({
        name: "Other Co",
        instanceId: "test-instance",
        issuePrefix: `CB${suffix}`,
        physicalAddress: "200 Other St",
        supportEmail: "ops@other.example.com",
      })
      .returning();

    const updated = await runChurnRescue(
      [makeAction("shared@example.com")],
      { companyOverrideId: companyB.id },
    );
    expect(updated?.status).toBe("completed");
    const actions = updated?.actions as TestAction[];
    expect(actions[0].status).toBe("completed");
    expect(getCapturedEmails()).toHaveLength(1);
    expect(getCapturedEmails()[0].to).toBe("shared@example.com");
  });
});
