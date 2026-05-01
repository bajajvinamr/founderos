import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Trust-boundary invariant test (Tier 1):
// An agent must not be able to approve their own work product. The
// FounderOS control-plane promise depends on this — if an agent could
// self-approve, the entire founder-review gate is theatre.
//
// Self-approval is prevented by *two* layers in issue-execution-policy.ts:
//   1. At submission: selectStageParticipant excludes the returnAssignee
//      (the original executor) from the participant pool. If the policy
//      was misconfigured to make the executor the only reviewer, the
//      pool is empty and the call throws "No eligible participant".
//   2. At advance time: only the actor matching currentParticipant can
//      request status="done". A different actor (specifically the
//      executor who submitted) attempting to advance throws
//      "Only the active reviewer or approver can advance the current
//      execution stage".
//
// These tests pin BOTH layers. Together they prove self-approval is
// unreachable, not just blocked at one specific path.

const EXECUTOR_AGENT = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEWER_AGENT = "bbbbbbbb-2222-4222-8222-222222222222";

describe("Tier 1 self-approval — Layer 1: submission with misconfigured policy", () => {
  it("rejects submission when executor is the only configured reviewer", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: EXECUTOR_AGENT }],
        },
      ],
    })!;

    // Executor agent submits work (status: in_progress -> in_review).
    // Because they're also the only reviewer, the participant pool is
    // empty after excluding the returnAssignee, and the policy must
    // refuse to enter review.
    expect(() =>
      applyIssueExecutionPolicyTransition({
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
      }),
    ).toThrow(/No eligible review participant/);
  });

  it("rejects submission when executor is the only approver in an approval-only policy", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "approval",
          participants: [{ type: "agent", agentId: EXECUTOR_AGENT }],
        },
      ],
    })!;

    expect(() =>
      applyIssueExecutionPolicyTransition({
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
      }),
    ).toThrow(/No eligible approval participant/);
  });
});

describe("Tier 1 self-approval — Layer 2: advance attempt by non-reviewer", () => {
  it("rejects requestedStatus=done when actor is the executor (returnAssignee), not the active reviewer", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT }],
        },
      ],
    })!;
    const stageId = policy.stages[0].id;

    // Issue is mid-review: assigned to reviewer, executor saved as returnAssignee.
    const executionState = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
      returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: REVIEWER_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
        commentBody: "looks great",
      }),
    ).toThrow(/Only the active reviewer or approver can advance the current execution stage/);
  });

  it("rejects requestedStatus=in_progress (changes-requested) when actor is the executor", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT }],
        },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const executionState = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
      returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: REVIEWER_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState,
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
        commentBody: "I changed my mind",
      }),
    ).toThrow(/Only the active reviewer or approver can advance the current execution stage/);
  });

  it("the active reviewer CAN advance (positive case — confirms guard is not over-restrictive)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT }],
        },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const executionState = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
      returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: REVIEWER_AGENT,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: REVIEWER_AGENT },
      commentBody: "approved",
    });

    expect(result.decision).toMatchObject({
      stageType: "review",
      outcome: "approved",
      body: "approved",
    });
  });

  it("approving a review without a comment is rejected (separate guard, but tested here for completeness)", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: REVIEWER_AGENT }],
        },
      ],
    })!;
    const stageId = policy.stages[0].id;

    const executionState = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
      returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: REVIEWER_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: REVIEWER_AGENT },
        commentBody: "",
      }),
    ).toThrow(/Approving a review or approval stage requires a comment/);
  });
});
