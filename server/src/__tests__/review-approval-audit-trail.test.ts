import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, asc } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  issues,
  issueExecutionDecisions,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Priority 3 — review/approval audit-trail integration test.
//
// The pure policy module is heavily unit-tested. This file verifies the
// route-handler contract that bridges the policy module to persistent
// state: a workflow that produces a `transition.decision` from
// `applyIssueExecutionPolicyTransition` MUST result in:
//   1. An `issueExecutionDecisions` row written, with the right
//      stage / outcome / body / actor.
//   2. The issue's `executionState.lastDecisionId` pointing at that
//      decision row.
//   3. Multiple decisions in a single workflow accumulate IN ORDER and
//      preserve every actor identity (agent vs user) cleanly.
//
// Without this audit trail, founders cannot see who approved/rejected
// their agents' work, and post-incident review is impossible. The
// invariant being pinned: every founder review decision is durable,
// queryable, and attributable.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review/approval audit-trail tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("review/approval audit trail — issueExecutionDecisions persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-review-audit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgents() {
    const companyId = randomUUID();
    const executorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const approverUserId = "founder-user-1";

    await db.insert(companies).values({
      id: companyId,
      name: "TenantA",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    for (const [id, name] of [
      [executorAgentId, "Builder"] as const,
      [reviewerAgentId, "Reviewer"] as const,
    ]) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    return { companyId, executorAgentId, reviewerAgentId, approverUserId };
  }

  async function createIssueWithPolicy(input: {
    companyId: string;
    executorAgentId: string;
    reviewerAgentId: string;
    approverUserId: string;
  }) {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: input.reviewerAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: input.approverUserId }] },
      ],
    })!;

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: "T-1",
      title: "Ship the thing",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.executorAgentId,
      executionPolicy: policy as never,
      executionState: null,
    });

    return { issueId, policy };
  }

  /**
   * Apply a single transition and persist its decision (if any) to the DB.
   * Mimics the route handler at server/src/routes/issues.ts:980-1010 in a
   * focused way — db.transaction wrapping the issue update plus the
   * decision insert.
   */
  async function transitionAndPersist(input: {
    issueId: string;
    requestedStatus?: string;
    actor: { agentId?: string | null; userId?: string | null };
    commentBody?: string | null;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0]);
    if (!issue) throw new Error("issue not found");

    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);

    const transition = applyIssueExecutionPolicyTransition({
      issue: {
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        executionPolicy: issue.executionPolicy,
        executionState: issue.executionState,
      },
      policy,
      requestedStatus: input.requestedStatus,
      requestedAssigneePatch: {},
      actor: input.actor,
      commentBody: input.commentBody,
    });

    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextState = transition.patch.executionState as Record<string, unknown>;
      transition.patch.executionState = {
        ...nextState,
        lastDecisionId: decisionId,
      };
    }

    await db.transaction(async (tx) => {
      const patch: Record<string, unknown> = { ...transition.patch, updatedAt: new Date() };
      await tx.update(issues).set(patch as never).where(eq(issues.id, input.issueId));

      if (transition.decision && decisionId) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: issue.companyId,
          issueId: input.issueId,
          stageId: transition.decision.stageId,
          stageType: transition.decision.stageType,
          actorAgentId: input.actor.agentId ?? null,
          actorUserId: input.actor.userId ?? null,
          outcome: transition.decision.outcome,
          body: transition.decision.body,
        });
      }
    });

    return { transition, decisionId };
  }

  it("approver-stage approve writes a decision row with stage=approval, outcome=approved, body, actorUserId", async () => {
    const seed = await seedCompanyWithAgents();
    const { issueId, policy } = await createIssueWithPolicy(seed);

    // Step 1: executor submits → enters review.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.executorAgentId },
    });

    // Step 2: reviewer agent approves stage 1 → advances to approval.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.reviewerAgentId },
      commentBody: "LGTM",
    });

    // Step 3: founder (user) approves stage 2 → workflow completes.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { userId: seed.approverUserId },
      commentBody: "Ship it",
    });

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt));

    expect(decisions).toHaveLength(2);

    const reviewDecision = decisions.find((d) => d.stageType === "review")!;
    expect(reviewDecision).toBeDefined();
    expect(reviewDecision).toMatchObject({
      stageType: "review",
      outcome: "approved",
      body: "LGTM",
      actorAgentId: seed.reviewerAgentId,
      actorUserId: null,
    });
    expect(reviewDecision.stageId).toBe(policy.stages[0].id);

    const approvalDecision = decisions.find((d) => d.stageType === "approval")!;
    expect(approvalDecision).toBeDefined();
    expect(approvalDecision).toMatchObject({
      stageType: "approval",
      outcome: "approved",
      body: "Ship it",
      actorAgentId: null,
      actorUserId: seed.approverUserId,
    });
    expect(approvalDecision.stageId).toBe(policy.stages[1].id);

    // Final issue state must point lastDecisionId at the most recent
    // decision (approval).
    const finalIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    const finalState = finalIssue?.executionState as { lastDecisionId?: string; status?: string } | null;
    expect(finalState?.lastDecisionId).toBe(approvalDecision.id);
    expect(finalState?.status).toBe("completed");
  });

  it("changes_requested at review writes a decision row with outcome=changes_requested and the executor regains assignee", async () => {
    const seed = await seedCompanyWithAgents();
    const { issueId, policy } = await createIssueWithPolicy(seed);

    // Step 1: executor submits.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.executorAgentId },
    });

    // Step 2: reviewer rejects (request changes).
    await transitionAndPersist({
      issueId,
      requestedStatus: "in_progress",
      actor: { agentId: seed.reviewerAgentId },
      commentBody: "Add a unit test before I approve this",
    });

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      stageType: "review",
      outcome: "changes_requested",
      body: "Add a unit test before I approve this",
      actorAgentId: seed.reviewerAgentId,
    });
    expect(decisions[0].stageId).toBe(policy.stages[0].id);

    // Issue must be back with the executor.
    const afterReject = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterReject?.status).toBe("in_progress");
    expect(afterReject?.assigneeAgentId).toBe(seed.executorAgentId);

    const stateAfterReject = afterReject?.executionState as {
      status?: string;
      lastDecisionId?: string;
      lastDecisionOutcome?: string;
    } | null;
    expect(stateAfterReject?.status).toBe("changes_requested");
    expect(stateAfterReject?.lastDecisionId).toBe(decisions[0].id);
    expect(stateAfterReject?.lastDecisionOutcome).toBe("changes_requested");
  });

  it("full reject → resubmit → approve cycle writes 2 decisions in chronological order", async () => {
    const seed = await seedCompanyWithAgents();
    const { issueId } = await createIssueWithPolicy(seed);

    // Step 1: executor submits.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.executorAgentId },
    });

    // Step 2: reviewer rejects.
    await transitionAndPersist({
      issueId,
      requestedStatus: "in_progress",
      actor: { agentId: seed.reviewerAgentId },
      commentBody: "Needs more tests",
    });

    // Step 3: executor resubmits (no decision recorded).
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.executorAgentId },
    });

    // Step 4: reviewer approves on the second pass.
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.reviewerAgentId },
      commentBody: "Tests added — approving now",
    });

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt));

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      stageType: "review",
      outcome: "changes_requested",
      body: "Needs more tests",
    });
    expect(decisions[1]).toMatchObject({
      stageType: "review",
      outcome: "approved",
      body: "Tests added — approving now",
    });
    // Same stageId — both decisions belong to the SAME review cycle.
    expect(decisions[0].stageId).toBe(decisions[1].stageId);
  });

  it("decision rows are tenant-scoped: companyId is set and matches the issue's companyId", async () => {
    const seed = await seedCompanyWithAgents();
    const { issueId } = await createIssueWithPolicy(seed);

    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.executorAgentId },
    });
    await transitionAndPersist({
      issueId,
      requestedStatus: "done",
      actor: { agentId: seed.reviewerAgentId },
      commentBody: "approved",
    });

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));

    expect(decisions).toHaveLength(1);
    expect(decisions[0].companyId).toBe(seed.companyId);
  });
});
