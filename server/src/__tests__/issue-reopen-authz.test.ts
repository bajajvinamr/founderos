import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Lifecycle invariant test (Tier 2):
// When a closed (done/cancelled) issue is reopened, the policy module
// MUST clear the stale executionState so the new lifecycle does not
// inherit the previous review/approval state. The guard at
// issue-execution-policy.ts:262-269 handles this; without it, a reopened
// issue would carry forward "approved" or "completed" state and could
// bypass the review gate on its second pass.
//
// Cross-tenant reopen is gated upstream by assertCompanyAccess
// (covered by tenant-isolation.test.ts in Tier 1). This test covers
// the post-auth state-machine invariants.

const EXECUTOR_AGENT = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEWER_AGENT = "bbbbbbbb-2222-4222-8222-222222222222";

function buildCompletedExecutionState(stageId: string) {
  return {
    status: "completed" as const,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
    completedStageIds: [stageId],
    lastDecisionId: "11111111-aaaa-4aaa-8aaa-111111111111",
    lastDecisionOutcome: "approved" as const,
  };
}

describe("Tier 2 — reopen-after-close clears stale execution state", () => {
  it("reopening a done issue (status=done -> todo) clears executionState to null", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "done",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(stageId),
      },
      policy,
      requestedStatus: "todo",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.executionState).toBeNull();
  });

  it("reopening a cancelled issue (status=cancelled -> todo) clears executionState", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "cancelled",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(stageId),
      },
      policy,
      requestedStatus: "todo",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.executionState).toBeNull();
  });

  it("reopening to in_progress also clears executionState (state machine treats all non-done/cancelled targets equivalently)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "done",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(stageId),
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.executionState).toBeNull();
  });

  it("reopen does NOT clear state when target is still done (idempotent — no-op)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "done",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(stageId),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.executionState).toBeUndefined();
  });

  it("reopen done -> cancelled also leaves executionState alone (both are closed states)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "done",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(stageId),
      },
      policy,
      requestedStatus: "cancelled",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.executionState).toBeUndefined();
  });

  it("after reopen, a fresh submission re-enters review (proves cleared state does NOT skip the gate)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;

    // Step 1: reopen done -> todo, executionState cleared.
    const reopenResult = applyIssueExecutionPolicyTransition({
      issue: {
        status: "done",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: buildCompletedExecutionState(policy.stages[0].id),
      },
      policy,
      requestedStatus: "todo",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });
    expect(reopenResult.patch.executionState).toBeNull();

    // Step 2: now-empty state, agent submits status=done. Per Tier 2 invariant 1,
    // this redirects to in_review with the first stage — proving the reopened
    // issue does NOT inherit "approved" outcome from the prior cycle.
    const submitResult = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(submitResult.patch.status).toBe("in_review");
    expect((submitResult.patch.executionState as { status?: string; lastDecisionOutcome?: string })?.status).toBe(
      "pending",
    );
    // Critical: the new state must NOT carry forward the prior approval.
    expect(
      (submitResult.patch.executionState as { lastDecisionOutcome?: string })?.lastDecisionOutcome,
    ).toBeNull();
  });

  it("reopen returns to in_progress with the previous returnAssignee when transitioning out of in_review (no policy)", () => {
    // No policy case — the simpler branch at lines 251-259 handles in_review -> in_progress
    // restoration of the returnAssignee.
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: REVIEWER_AGENT,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: {
          status: "pending",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: EXECUTOR_AGENT, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy: null,
      requestedAssigneePatch: {},
      actor: { agentId: REVIEWER_AGENT },
    });

    expect(result.patch.executionState).toBeNull();
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(EXECUTOR_AGENT);
  });
});
