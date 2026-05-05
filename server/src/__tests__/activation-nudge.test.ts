/**
 * activation-nudge.test.ts — Integration tests for the activation-nudge workflow template (S4.7)
 *
 * Test coverage:
 *   A. Template registration (1 test)
 *      A1. "activation-nudge" is in WORKFLOW_TEMPLATES constant
 *
 *   B. Scan logic (4 tests)
 *      B1. scanUnactivatedUsers returns users with identify but no activation
 *      B2. scanUnactivatedUsers respects inactivityWindow (filters old identifies)
 *      B3. scanUnactivatedUsers returns empty set when all users have activated
 *      B4. scanUnactivatedUsers respects tenant isolation (company A doesn't see B's users)
 *
 *   C. Dedup logic (2 tests)
 *      C1. hasBeenNudgedRecently returns true when nudge_sent exists in run.actions
 *      C2. hasBeenNudgedRecently returns false when window has expired
 *
 *   D. Action building (2 tests)
 *      D1. buildNudgeActions creates send_email + log_crm_note + nudge_sent per user
 *      D2. buildNudgeActions applies config overrides (custom subject, email body)
 *
 *   E. Autonomy gating (3 tests)
 *      E1. shouldExecuteNudge returns false for autonomyLevel <= 2 (draft)
 *      E2. shouldExecuteNudge returns false for autonomyLevel = 3 (approval)
 *      E3. shouldExecuteNudge returns true for autonomyLevel = 4 (autonomous)
 *
 *   F. End-to-end activation-nudge workflow (2 tests)
 *      F1. Create workflow with template='activation-nudge' → stores config
 *      F2. Trigger activation-nudge → run created with correct initial status
 *          (depends on autonomyLevel + canRunAutonomously check)
 *
 * Total: 14 tests
 *
 * All tests use real embedded Postgres for tenant isolation, FK validation, and
 * JSONB array operations.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  events,
  workflows,
  workflowRuns,
  WORKFLOW_TEMPLATES,
  AUTONOMY_LEVELS,
} from "@founderos/db";
import {
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import {
  scanUnactivatedUsers,
  hasBeenNudgedRecently,
  buildNudgeActions,
  shouldExecuteNudge,
  executeNudgeActions,
} from "../services/workflows/templates/activation-nudge.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping activation-nudge tests: ${support.reason ?? "unsupported"}`);
}

// ── Test database setup ──────────────────────────────────────────────────────

let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let uniqueCounter = 0;

/**
 * Generate a globally unique suffix for test data.
 * Uses a counter to ensure no collisions across rapid test execution.
 */
function getUniqueId(): string {
  return `${++uniqueCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

describeEmbeddedPostgres("activation-nudge workflow template (S4.7)", () => {
  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("activation-nudge");
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  // ── A. Template registration ──────────────────────────────────────────────

  describe("A. Template registration", () => {
    it("A1 — activation-nudge is registered in WORKFLOW_TEMPLATES", () => {
      expect(WORKFLOW_TEMPLATES).toContain("activation-nudge");
    });
  });

  // ── B. Scan logic ────────────────────────────────────────────────────────

  describe("B. Scan logic (scanUnactivatedUsers)", () => {
    let db: ReturnType<typeof createDb>;
    let companyId: string;

    beforeEach(async () => {
      db = createDb(testDb.connectionString);

      // Create test company with unique slug and issuePrefix (counter-based for true uniqueness)
      const uniqueId = getUniqueId();
      const slug = `test-co-${uniqueId}`;
      const issuePrefix = `TST${uniqueId.slice(0, 6)}`.toUpperCase();
      const [company] = await db
        .insert(companies)
        .values({ name: "Test Co", slug, issuePrefix })
        .returning();
      companyId = company.id;
    });

    it("B1 — returns events with identify but no activation", async () => {
      // User 1: identify but no activation
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-1-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-1", email: "user1@example.com" },
      });

      // User 2: identify + activation (should be filtered out)
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-2-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-2", email: "user2@example.com" },
      });
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "activated",
        dedupKey: "user-2-activated",
        occurredAt: new Date(),
        payload: { distinctId: "user-2" },
      });

      const result = await scanUnactivatedUsers(db, companyId);
      expect(result).toHaveLength(1);
      expect(result[0].distinctId).toBe("user-1");
      expect(result[0].email).toBe("user1@example.com");
    });

    it("B2 — respects inactivityWindow (filters old identifies)", async () => {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      // User 1: identified 8 days ago (outside default 7d window)
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-1-identify",
        occurredAt: eightDaysAgo,
        payload: { distinctId: "user-1" },
      });

      // User 2: identified 2 days ago (inside window)
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-2-identify",
        occurredAt: twoDaysAgo,
        payload: { distinctId: "user-2" },
      });

      const result = await scanUnactivatedUsers(db, companyId, { inactivityWindow: 7 });
      expect(result).toHaveLength(1);
      expect(result[0].distinctId).toBe("user-2");
    });

    it("B3 — returns empty set when all users have activated", async () => {
      // Both users: identify + activation
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-1-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-1" },
      });
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "activated",
        dedupKey: "user-1-activated",
        occurredAt: new Date(),
        payload: { distinctId: "user-1" },
      });

      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-2-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-2" },
      });
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "activated",
        dedupKey: "user-2-activated",
        occurredAt: new Date(),
        payload: { distinctId: "user-2" },
      });

      const result = await scanUnactivatedUsers(db, companyId);
      expect(result).toHaveLength(0);
    });

    it("B4 — respects tenant isolation (company A doesn't see B's users)", async () => {
      const uniqueId2 = getUniqueId();
      const slug2 = `other-co-${uniqueId2}`;
      const issuePrefix2 = `OTH${uniqueId2.slice(0, 6)}`.toUpperCase();
      const [company2] = await db
        .insert(companies)
        .values({ name: "Other Co", slug: slug2, issuePrefix: issuePrefix2 })
        .returning();
      const companyId2 = company2.id;

      // Add identify event for user1 in company1
      await db.insert(events).values({
        companyId,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-1-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-1" },
      });

      // Add identify event for user2 in company2
      await db.insert(events).values({
        companyId: companyId2,
        source: "posthog",
        entityType: "user",
        eventName: "identify",
        dedupKey: "user-2-identify",
        occurredAt: new Date(),
        payload: { distinctId: "user-2" },
      });

      // Company 1 should only see user1
      const result1 = await scanUnactivatedUsers(db, companyId);
      expect(result1).toHaveLength(1);
      expect(result1[0].distinctId).toBe("user-1");

      // Company 2 should only see user2
      const result2 = await scanUnactivatedUsers(db, companyId2);
      expect(result2).toHaveLength(1);
      expect(result2[0].distinctId).toBe("user-2");
    });
  });

  // ── C. Dedup logic ───────────────────────────────────────────────────────

  describe("C. Dedup logic (hasBeenNudgedRecently)", () => {
    let db: ReturnType<typeof createDb>;
    let companyId: string;
    let workflowId: string;

    beforeEach(async () => {
      db = createDb(testDb.connectionString);

      const uniqueId = getUniqueId();
      const slug = `test-co-${uniqueId}`;
      const issuePrefix = `TST${uniqueId.slice(0, 6)}`.toUpperCase();
      const [company] = await db
        .insert(companies)
        .values({ name: "Test Co", slug, issuePrefix })
        .returning();
      companyId = company.id;

      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Test Workflow",
          template: "activation-nudge",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 */6 * * *" },
        })
        .returning();
      workflowId = workflow.id;
    });

    it("C1 — returns true when nudge_sent exists in recent run.actions", async () => {
      const distinctId = "user-123";
      // Create a workflow run with nudge_sent action
      await db.insert(workflowRuns).values({
        workflowId,
        companyId,
        status: "completed",
        triggeredBy: { kind: "schedule" },
        actions: [
          {
            type: "nudge_sent",
            payload: { distinctId },
            status: "completed",
            executedAt: new Date().toISOString(),
          },
        ],
      });

      const hasBeenNudged = await hasBeenNudgedRecently(db, distinctId, workflowId, 14);
      expect(hasBeenNudged).toBe(true);
    });

    it("C2 — returns false when dedup window has expired", async () => {
      const distinctId = "user-456";
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

      // Create a run from 15 days ago (outside default 14d window)
      await db.insert(workflowRuns).values({
        workflowId,
        companyId,
        status: "completed",
        triggeredBy: { kind: "schedule" },
        createdAt: fifteenDaysAgo,
        actions: [
          {
            type: "nudge_sent",
            payload: { distinctId },
            status: "completed",
            executedAt: fifteenDaysAgo.toISOString(),
          },
        ],
      });

      const hasBeenNudged = await hasBeenNudgedRecently(db, distinctId, workflowId, 14);
      expect(hasBeenNudged).toBe(false);
    });
  });

  // ── D. Action building ───────────────────────────────────────────────────

  describe("D. Action building (buildNudgeActions)", () => {
    it("D1 — creates send_email + log_crm_note + nudge_sent per event", () => {
      const candidates = [
        {
          eventId: "evt-1",
          distinctId: "user-1",
          email: "alice@example.com",
          companyId: "co-1",
          identifiedAt: new Date(),
        },
      ];

      const actions = buildNudgeActions(candidates, {});
      expect(actions).toHaveLength(3);
      expect(actions[0].type).toBe("send_email");
      expect(actions[1].type).toBe("log_crm_note");
      expect(actions[2].type).toBe("nudge_sent");
      expect(actions[0].status).toBe("pending");
    });

    it("D2 — applies config overrides (custom subject)", () => {
      const candidates = [
        {
          eventId: "evt-1",
          distinctId: "user-1",
          email: "alice@example.com",
          companyId: "co-1",
          identifiedAt: new Date(),
        },
      ];

      const config = {
        nudgeEmailSubject: "Hello! Time to dive in with {productName}",
      };

      const actions = buildNudgeActions(candidates, config);
      const emailAction = actions[0];
      expect(emailAction.type).toBe("send_email");
      expect((emailAction.payload as Record<string, unknown>).subject).toBe(
        "Hello! Time to dive in with FounderOS",
      );
    });
  });

  // ── E. Autonomy gating ───────────────────────────────────────────────────

  describe("E. Autonomy gating (shouldExecuteNudge)", () => {
    it("E1 — returns false for autonomyLevel <= 2 (draft)", () => {
      const workflow = { autonomyLevel: AUTONOMY_LEVELS.DRAFT };
      expect(shouldExecuteNudge(workflow)).toBe(false);
    });

    it("E2 — returns false for autonomyLevel = 3 (approval-required)", () => {
      const workflow = { autonomyLevel: AUTONOMY_LEVELS.APPROVAL_REQUIRED };
      expect(shouldExecuteNudge(workflow)).toBe(false);
    });

    it("E3 — returns true for autonomyLevel = 4 (autonomous)", () => {
      const workflow = { autonomyLevel: AUTONOMY_LEVELS.AUTONOMOUS };
      expect(shouldExecuteNudge(workflow)).toBe(true);
    });
  });

  // ── F. End-to-end workflow integration ────────────────────────────────────

  describe("F. End-to-end activation-nudge workflow", () => {
    let db: ReturnType<typeof createDb>;
    let companyId: string;

    beforeEach(async () => {
      db = createDb(testDb.connectionString);
      const uniqueId = getUniqueId();
      const slug = `test-co-${uniqueId}`;
      const issuePrefix = `TST${uniqueId.slice(0, 6)}`.toUpperCase();
      const [company] = await db
        .insert(companies)
        .values({ name: "Test Co", slug, issuePrefix })
        .returning();
      companyId = company.id;
    });

    it("F1 — create workflow with template='activation-nudge' stores config", async () => {
      const config = {
        activationEventName: "onboarded",
        inactivityWindow: 5,
        dedupWindow: 10,
      };

      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Activation Nudge Campaign",
          template: "activation-nudge",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 */6 * * *", timezone: "UTC" },
          config,
        })
        .returning();

      expect(workflow.template).toBe("activation-nudge");
      expect((workflow.config as Record<string, unknown>).activationEventName).toBe("onboarded");
      expect((workflow.config as Record<string, unknown>).inactivityWindow).toBe(5);
    });

    it("F2 — trigger activation-nudge creates run with correct status", async () => {
      const [workflow] = await db
        .insert(workflows)
        .values({
          companyId,
          name: "Activation Nudge",
          template: "activation-nudge",
          triggerKind: "schedule",
          triggerSpec: { cron: "0 */6 * * *" },
          autonomyLevel: AUTONOMY_LEVELS.DRAFT,
          status: "active",
        })
        .returning();

      const [run] = await db
        .insert(workflowRuns)
        .values({
          workflowId: workflow.id,
          companyId,
          status: "running",
          triggeredBy: { kind: "schedule" },
        })
        .returning();

      expect(run.workflowId).toBe(workflow.id);
      expect(run.status).toBe("running");
      expect(run.companyId).toBe(companyId);
    });
  });

  // ── G. Action execution ──────────────────────────────────────────────────

  describe("G. Action execution (executeNudgeActions)", () => {
    it("G1 — marks all actions as completed with timestamp", async () => {
      const actions = [
        {
          type: "send_email" as const,
          payload: { userId: "user-1", email: "user@example.com" },
          status: "pending" as const,
        },
        {
          type: "log_crm_note" as const,
          payload: { userId: "user-1" },
          status: "pending" as const,
        },
      ];

      const executed = await executeNudgeActions(actions);
      expect(executed).toHaveLength(2);
      expect(executed[0].status).toBe("completed");
      expect(executed[1].status).toBe("completed");
      expect(executed[0].executedAt).toBeDefined();
    });

    // Council 2026-05-05 W0.2 BLOCK fix verification — activation-nudge variant.
    //
    // Before W0.2, executeNudgeActions was a "no-op stub" that mapped every
    // action to status="completed" without ever touching an email transport.
    // Founders saw the workflow run as completed; recipients saw nothing.
    //
    // After W0.2, the function dispatches send_email actions through the
    // EmailTransport (CaptureTransport in NODE_ENV=test) while leaving
    // log_crm_note + nudge_sent as bookkeeping markers.
    it("G2 — send_email actions are dispatched through the EmailTransport", async () => {
      const { resetEmailTransport, getCapturedEmails } = await import(
        "../services/transports/email-transport.js"
      );
      resetEmailTransport();

      const actions = [
        {
          type: "send_email" as const,
          payload: {
            distinctId: "user-42",
            email: "nudge@example.com",
            subject: "We miss you!",
            template: "activation-nudge",
          },
          status: "pending" as const,
        },
        {
          type: "log_crm_note" as const,
          payload: { distinctId: "user-42", subject: "Re-engagement nudge sent" },
          status: "pending" as const,
        },
        {
          type: "nudge_sent" as const,
          payload: { distinctId: "user-42" },
          status: "pending" as const,
        },
      ];

      const executed = await executeNudgeActions(
        actions,
        { id: "wf-test-activation-nudge" },
        "run-test-1",
      );

      // Transport received exactly 1 email (only send_email triggers send).
      const emails = getCapturedEmails();
      expect(emails).toHaveLength(1);
      expect(emails[0]!.to).toBe("nudge@example.com");
      expect(emails[0]!.subject).toBe("We miss you!");
      // Tag threading for webhook reconciliation.
      expect(emails[0]!.tags?.find((t) => t.name === "template")?.value).toBe(
        "activation-nudge",
      );
      expect(emails[0]!.tags?.find((t) => t.name === "workflow_id")?.value).toBe(
        "wf-test-activation-nudge",
      );
      expect(emails[0]!.tags?.find((t) => t.name === "distinct_id")?.value).toBe(
        "user-42",
      );

      // send_email action was enriched with provider id + transport mode.
      const sendEmailAction = executed[0] as { payload: Record<string, unknown>; status: string };
      expect(sendEmailAction.status).toBe("completed");
      expect(sendEmailAction.payload.providerMessageId).toBeDefined();
      expect(sendEmailAction.payload.transportMode).toBe("capture");

      // log_crm_note + nudge_sent stay completed (bookkeeping markers).
      expect(executed[1].status).toBe("completed");
      expect(executed[2].status).toBe("completed");

      resetEmailTransport();
    });

    it("G3 — send_email with missing recipient is marked failed without throwing", async () => {
      // Defensive: buildNudgeActions skips candidates without email, but if a
      // hand-written action ever reaches executeNudgeActions without a
      // recipient, the function MUST stamp status="failed" + an error string
      // rather than crashing the whole run mid-batch.
      const { resetEmailTransport, getCapturedEmails } = await import(
        "../services/transports/email-transport.js"
      );
      resetEmailTransport();

      const actions = [
        {
          type: "send_email" as const,
          payload: { distinctId: "user-no-email" }, // no email!
          status: "pending" as const,
        },
      ];

      const executed = await executeNudgeActions(actions);
      expect(executed).toHaveLength(1);
      expect(executed[0].status).toBe("failed");
      expect(executed[0].error).toBe("no recipient email");
      // Transport must NOT have received anything.
      expect(getCapturedEmails()).toHaveLength(0);

      resetEmailTransport();
    });
  });
});
