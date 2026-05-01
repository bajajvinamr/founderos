import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Lifecycle invariant test (Tier 2):
// When an issue has an executionPolicy with required review/approval stages,
// the founder/agent CANNOT skip review and close the issue directly. The
// policy transformer at applyIssueExecutionPolicyTransition redirects
// requestedStatus="done" into "in_review" + the first pending stage, so
// the issue never actually transitions to done without going through
// the gate.
//
// This pins the FounderOS control-plane promise: agents cannot bypass
// the review gate by simply requesting status=done. Today's guards live
// at issue-execution-policy.ts:426-463 (workflow start) and 332-343
// (workflow advance with no next stage).

const EXECUTOR_AGENT = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEWER_AGENT = "bbbbbbbb-2222-4222-8222-222222222222";
const APPROVER_USER = "approver-user-1";

describe("Tier 2 — issue cannot close while review pending", () => {
  it("requestedStatus=done on an issue with a single review stage redirects to in_review (does NOT close)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;

    const result = applyIssueExecutionPolicyTransition({
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

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.status).not.toBe("done");
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: REVIEWER_AGENT },
    });
  });

  it("requestedStatus=done on a multi-stage policy enters the FIRST stage, not the last", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
        { type: "approval", participants: [{ type: "user", userId: APPROVER_USER }] },
      ],
    })!;
    const firstStageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
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

    expect(result.patch.status).toBe("in_review");
    expect((result.patch.executionState as { currentStageId?: string })?.currentStageId).toBe(
      firstStageId,
    );
  });

  it("after review approves, requestedStatus=done from the approver completes the workflow", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
        { type: "approval", participants: [{ type: "user", userId: APPROVER_USER }] },
      ],
    })!;
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;

    // Reviewer approves stage 1 → workflow moves to stage 2.
    const afterReview = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: REVIEWER_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: REVIEWER_AGENT, userId: null },
          returnAssignee: { type: "agent", agentId: EXECUTOR_AGENT, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: REVIEWER_AGENT },
      commentBody: "looks good",
    });

    expect(afterReview.decision?.outcome).toBe("approved");
    expect((afterReview.patch.executionState as { currentStageId?: string })?.currentStageId).toBe(
      approvalStageId,
    );

    // Approver approves stage 2 → workflow completes; executionState.status=completed.
    const afterApproval = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: APPROVER_USER,
        executionPolicy: policy,
        executionState: afterApproval_loadInputState(afterReview.patch.executionState),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: APPROVER_USER },
      commentBody: "ship it",
    });

    expect(afterApproval.decision?.outcome).toBe("approved");
    expect((afterApproval.patch.executionState as { status?: string })?.status).toBe("completed");
  });

  it("issues with NO executionPolicy can transition to done normally (guard does not over-block)", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: null,
      },
      policy: null,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    // Empty patch — the route is free to set status=done itself when
    // there's no policy. The guard only kicks in when a policy exists.
    expect(result.patch.status).toBeUndefined();
    expect(result.patch.executionState).toBeUndefined();
  });

  it("requestedStatus=in_review (explicit submit) on a fresh policy enters review correctly", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      ],
    })!;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: EXECUTOR_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT },
    });

    expect(result.patch.status).toBe("in_review");
    expect((result.patch.executionState as { status?: string })?.status).toBe("pending");
  });
});

// IssueExecutionState shape comes from the policy module; we accept the
// patch's executionState back as input on the next transition call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function afterApproval_loadInputState(value: unknown): any {
  return value;
}
