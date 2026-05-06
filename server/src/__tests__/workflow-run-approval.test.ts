/**
 * workflow-run-approval.test.ts — S4.8 prerequisite #194.
 *
 * Tests the workflow_run approval state machine.
 *
 * State graph under test:
 *   pending_approval → approved (transient)
 *                    → rejected (terminal)
 *
 * Coverage:
 *   1. approve from pending_approval → success, applied=true
 *   2. approve from approved → idempotent, applied=false
 *   3. approve from running → InvalidWorkflowRunTransitionError
 *   4. approve from completed → InvalidWorkflowRunTransitionError
 *   5. approve unknown id → WorkflowRunNotFoundError
 *   6. reject from pending_approval → success
 *   7. reject from rejected → idempotent
 *   8. reject from approved → InvalidWorkflowRunTransitionError
 *   9. activity_log row written on each successful transition
 *  10. isTerminalWorkflowRunStatus identifies terminal states
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  workflowRuns,
  workflows,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  approveWorkflowRun,
  InvalidWorkflowRunTransitionError,
  isTerminalWorkflowRunStatus,
  rejectWorkflowRun,
  WorkflowRunNotFoundError,
} from "../services/workflow-run-approval.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping workflow-run-approval tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("workflow-run-approval", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let workflowId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("wf-run-approval");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.execute(sql`TRUNCATE TABLE activity_log`);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: "WF Run Approval Co", instanceId: "test", issuePrefix: `WA${suffix}` })
      .returning();
    companyId = company.id;

    const [w] = await db
      .insert(workflows)
      .values({
        companyId,
        name: "Approval test",
        template: "churn-rescue",
        triggerKind: "schedule",
        triggerSpec: { cron: "0 12 * * *" },
        autonomyLevel: 3,
        status: "active",
        config: {},
      })
      .returning();
    workflowId = w.id;
  });

  async function seedRun(status: "pending_approval" | "running" | "completed" | "approved" | "rejected") {
    const [run] = await db
      .insert(workflowRuns)
      .values({
        workflowId,
        companyId,
        status,
        triggeredBy: { kind: "test" },
        actions: [],
        idempotencyKey: `seed-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();
    return run;
  }

  describe("approveWorkflowRun", () => {
    it("transitions pending_approval → approved", async () => {
      const run = await seedRun("pending_approval");
      const result = await approveWorkflowRun(db, run.id, "user-decider", "looks good");

      expect(result.applied).toBe(true);
      if (!result.applied) return;
      expect(result.run.status).toBe("approved");
    });

    it("idempotent: approving an already-approved run returns applied=false", async () => {
      const run = await seedRun("approved");
      const result = await approveWorkflowRun(db, run.id, "user-decider");

      expect(result.applied).toBe(false);
      if (result.applied) return;
      expect(result.reason).toBe("already_in_target_state");
      expect(result.run.status).toBe("approved");
    });

    it("rejects approval from running state", async () => {
      const run = await seedRun("running");
      await expect(
        approveWorkflowRun(db, run.id, "user-decider"),
      ).rejects.toBeInstanceOf(InvalidWorkflowRunTransitionError);
    });

    it("rejects approval from completed (terminal) state", async () => {
      const run = await seedRun("completed");
      await expect(
        approveWorkflowRun(db, run.id, "user-decider"),
      ).rejects.toBeInstanceOf(InvalidWorkflowRunTransitionError);
    });

    it("rejects approval from rejected (terminal) state", async () => {
      const run = await seedRun("rejected");
      await expect(
        approveWorkflowRun(db, run.id, "user-decider"),
      ).rejects.toBeInstanceOf(InvalidWorkflowRunTransitionError);
    });

    it("throws WorkflowRunNotFoundError on unknown id", async () => {
      await expect(
        approveWorkflowRun(
          db,
          "00000000-0000-0000-0000-000000000000",
          "user-decider",
        ),
      ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    });
  });

  describe("rejectWorkflowRun", () => {
    it("transitions pending_approval → rejected", async () => {
      const run = await seedRun("pending_approval");
      const result = await rejectWorkflowRun(db, run.id, "user-decider", "no thanks");

      expect(result.applied).toBe(true);
      if (!result.applied) return;
      expect(result.run.status).toBe("rejected");
    });

    it("idempotent: rejecting an already-rejected run returns applied=false", async () => {
      const run = await seedRun("rejected");
      const result = await rejectWorkflowRun(db, run.id, "user-decider");
      expect(result.applied).toBe(false);
    });

    it("rejects reject from approved state (illegal — was already approved)", async () => {
      const run = await seedRun("approved");
      await expect(
        rejectWorkflowRun(db, run.id, "user-decider"),
      ).rejects.toBeInstanceOf(InvalidWorkflowRunTransitionError);
    });

    it("rejects reject from completed (terminal) state", async () => {
      const run = await seedRun("completed");
      await expect(
        rejectWorkflowRun(db, run.id, "user-decider"),
      ).rejects.toBeInstanceOf(InvalidWorkflowRunTransitionError);
    });
  });

  describe("audit trail", () => {
    it("writes an activity_log row on successful approve", async () => {
      const run = await seedRun("pending_approval");
      await approveWorkflowRun(db, run.id, "user-1", "approved by founder");

      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, run.id));

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const approvalRow = rows.find(
        (r) => r.action === "workflow_run_approved",
      );
      expect(approvalRow).toBeDefined();
      expect(approvalRow!.actorId).toBe("user-1");
      expect(approvalRow!.workflowId).toBe(workflowId);
      expect((approvalRow!.details as Record<string, unknown>).from).toBe(
        "pending_approval",
      );
      expect((approvalRow!.details as Record<string, unknown>).to).toBe(
        "approved",
      );
    });

    it("writes an activity_log row on successful reject", async () => {
      const run = await seedRun("pending_approval");
      await rejectWorkflowRun(db, run.id, "user-1", "scope concerns");

      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, run.id));

      const rejectRow = rows.find((r) => r.action === "workflow_run_rejected");
      expect(rejectRow).toBeDefined();
      expect(
        (rejectRow!.details as Record<string, unknown>).decisionNote,
      ).toBe("scope concerns");
    });

    it("does NOT write activity_log row on idempotent no-op", async () => {
      const run = await seedRun("approved");
      await approveWorkflowRun(db, run.id, "user-1");

      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, run.id));

      expect(rows).toHaveLength(0);
    });
  });

  describe("isTerminalWorkflowRunStatus", () => {
    it("identifies terminal states", () => {
      expect(isTerminalWorkflowRunStatus("completed")).toBe(true);
      expect(isTerminalWorkflowRunStatus("failed")).toBe(true);
      expect(isTerminalWorkflowRunStatus("rejected")).toBe(true);
    });

    it("does NOT identify transient states as terminal", () => {
      expect(isTerminalWorkflowRunStatus("pending_approval")).toBe(false);
      expect(isTerminalWorkflowRunStatus("running")).toBe(false);
      expect(isTerminalWorkflowRunStatus("approved")).toBe(false);
      expect(isTerminalWorkflowRunStatus("cancelled")).toBe(false);
    });
  });
});
