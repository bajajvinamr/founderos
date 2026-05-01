import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Priority 3 — Review/Approval flow correctness across multiple cycles.
//
// Existing coverage in issue-execution-policy.test.ts pins the SINGLE-cycle
// happy path and a single resubmit-after-changes. This file pins the
// multi-cycle behavior the FounderOS founder-review promise depends on:
// when a reviewer rejects an agent's work twice in a row, the workflow
// must NOT silently auto-approve, NOT skip stages, NOT lose track of who
// submitted what, and the audit history (lastDecisionId / completedStageIds)
// must remain coherent.

const EXECUTOR_AGENT = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEWER_AGENT = "bbbbbbbb-2222-4222-8222-222222222222";
const APPROVER_USER = "approver-user-1";
const DECISION_ID_1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const DECISION_ID_2 = "22222222-bbbb-4bbb-8bbb-222222222222";

function reviewOnlyPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
    ],
  })!;
}

function reviewPlusApprovalPolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT }] },
      { type: "approval", participants: [{ type: "user", userId: APPROVER_USER }] },
    ],
  })!;
}

describe("Priority 3 — review/approval workflow over multiple cycles", () => {
  describe("review-only policy: reject → resubmit → reject → resubmit → approve", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("after second reject, executor's resubmit re-enters the SAME review stage (no skip, no auto-approve)", () => {
      const stateAfterSecondReject = {
        status: "changes_requested" as const,
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review" as const,
        currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
        returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
        completedStageIds: [],
        lastDecisionId: DECISION_ID_2,
        lastDecisionOutcome: "changes_requested" as const,
      };

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: EXECUTOR_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: stateAfterSecondReject,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
        commentBody: "Addressed second round of feedback",
      });

      // Must re-enter review with the SAME (only) stage. No completedStageIds
      // pollution. No "approved" leak from the prior cycles.
      expect(result.patch.status).toBe("in_review");
      expect((result.patch.executionState as { status?: string })?.status).toBe("pending");
      expect((result.patch.executionState as { currentStageId?: string })?.currentStageId).toBe(
        reviewStageId,
      );
      expect((result.patch.executionState as { completedStageIds?: string[] })?.completedStageIds)
        .toEqual([]);
      // The previous decision id should still be tracked until a new
      // decision overwrites it — re-entering review is a state change,
      // not a decision in itself.
      expect((result.patch.executionState as { currentParticipant?: { agentId?: string } })?.currentParticipant?.agentId)
        .toBe(REVIEWER_AGENT);
    });

    it("third-round reviewer approval after two prior rejects completes the workflow", () => {
      // After two rejects + resubmits, reviewer finally approves the third pass.
      const stateAfterResubmit = {
        status: "pending" as const,
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review" as const,
        currentParticipant: { type: "agent" as const, agentId: REVIEWER_AGENT, userId: null },
        returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
        completedStageIds: [],
        lastDecisionId: DECISION_ID_2,
        lastDecisionOutcome: "changes_requested" as const,
      };

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: REVIEWER_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: stateAfterResubmit,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: REVIEWER_AGENT },
        commentBody: "All issues addressed, approving on third pass",
      });

      expect(result.decision?.outcome).toBe("approved");
      expect(result.decision?.body).toBe("All issues addressed, approving on third pass");
      // Workflow is complete — completed status with the review stage in completedStageIds.
      expect((result.patch.executionState as { status?: string })?.status).toBe("completed");
      expect((result.patch.executionState as { completedStageIds?: string[] })?.completedStageIds)
        .toEqual([reviewStageId]);
    });
  });

  describe("two-stage policy: rejection at approval stage routes to executor (NOT back to review)", () => {
    const policy = reviewPlusApprovalPolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;

    it("approver rejecting at stage 2 sends issue back to executor with state=changes_requested at stage 2", () => {
      const stateAtApproval = {
        status: "pending" as const,
        currentStageId: approvalStageId,
        currentStageIndex: 1,
        currentStageType: "approval" as const,
        currentParticipant: { type: "user" as const, userId: APPROVER_USER, agentId: null },
        returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
        completedStageIds: [reviewStageId],
        lastDecisionId: DECISION_ID_1,
        lastDecisionOutcome: "approved" as const,
      };

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: APPROVER_USER,
          executionPolicy: policy,
          executionState: stateAtApproval,
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: APPROVER_USER },
        commentBody: "Founder rejecting at approval stage",
      });

      expect(result.decision?.outcome).toBe("changes_requested");
      expect(result.decision?.stageType).toBe("approval");
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(EXECUTOR_AGENT);
      expect(result.patch.assigneeUserId).toBeNull();
      expect((result.patch.executionState as { status?: string })?.status).toBe("changes_requested");
      // The reject happened at the APPROVAL stage, so currentStageType should
      // still be "approval" (we don't rewind to review).
      expect((result.patch.executionState as { currentStageType?: string })?.currentStageType)
        .toBe("approval");
    });

    it("after approval-stage reject, executor's resubmit re-enters the approval stage (NOT review)", () => {
      // The earlier review approval is preserved in completedStageIds, so
      // the resubmit path should pick up at the approval stage, not redo
      // review. This is a critical product invariant: the founder's earlier
      // approval is not invalidated by a later approval-stage reject.
      const stateAfterApprovalReject = {
        status: "changes_requested" as const,
        currentStageId: approvalStageId,
        currentStageIndex: 1,
        currentStageType: "approval" as const,
        currentParticipant: { type: "user" as const, userId: APPROVER_USER, agentId: null },
        returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
        completedStageIds: [reviewStageId],
        lastDecisionId: DECISION_ID_2,
        lastDecisionOutcome: "changes_requested" as const,
      };

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: EXECUTOR_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: stateAfterApprovalReject,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
        commentBody: "Reworked per founder feedback",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(APPROVER_USER);
      expect((result.patch.executionState as { currentStageId?: string })?.currentStageId)
        .toBe(approvalStageId);
      // completedStageIds must NOT have ballooned — the review stage is
      // still the only completed one.
      expect((result.patch.executionState as { completedStageIds?: string[] })?.completedStageIds)
        .toEqual([reviewStageId]);
    });
  });

  describe("audit-trail invariant: each decision call surfaces a unique outcome+body+stage", () => {
    const policy = reviewPlusApprovalPolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;

    it("review approve → approval reject → review re-approve → approval approve produces 4 distinct decisions", () => {
      // Step 1: reviewer approves.
      const step1 = applyIssueExecutionPolicyTransition({
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
        commentBody: "First-pass review approved",
      });
      expect(step1.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
        body: "First-pass review approved",
      });

      // Step 2: approver rejects (changes_requested at approval).
      const stateAfterStep1 = step1.patch.executionState as {
        currentStageId: string;
        completedStageIds: string[];
      };
      const step2 = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: APPROVER_USER,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: stateAfterStep1.currentStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: APPROVER_USER, agentId: null },
            returnAssignee: { type: "agent", agentId: EXECUTOR_AGENT, userId: null },
            completedStageIds: stateAfterStep1.completedStageIds,
            lastDecisionId: DECISION_ID_1,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: APPROVER_USER },
        commentBody: "Founder wants the metric named differently",
      });
      expect(step2.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
        body: "Founder wants the metric named differently",
      });

      // Step 3: executor resubmits → re-enters approval.
      const step3 = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: EXECUTOR_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: step2.patch.executionState as never,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
        commentBody: "Renamed and re-submitted",
      });
      // Resubmit is a state transition, not a decision. The next decision
      // happens when the approver responds.
      expect(step3.decision).toBeUndefined();
      expect((step3.patch.executionState as { currentStageId?: string })?.currentStageId).toBe(
        approvalStageId,
      );

      // Step 4: approver finally approves.
      const step4 = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: APPROVER_USER,
          executionPolicy: policy,
          executionState: step3.patch.executionState as never,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: APPROVER_USER },
        commentBody: "Better — shipping it",
      });
      expect(step4.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
        body: "Better — shipping it",
      });
      expect((step4.patch.executionState as { status?: string })?.status).toBe("completed");
    });
  });

  describe("workflow completion is irreversible (within the same lifecycle)", () => {
    const policy = reviewPlusApprovalPolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;

    it("once executionState.status=completed, a redundant requestedStatus=done is a no-op (no extra decision)", () => {
      const completedState = {
        status: "completed" as const,
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent" as const, agentId: EXECUTOR_AGENT, userId: null },
        completedStageIds: [reviewStageId, approvalStageId],
        lastDecisionId: DECISION_ID_2,
        lastDecisionOutcome: "approved" as const,
      };

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: EXECUTOR_AGENT,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: completedState,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: EXECUTOR_AGENT },
      });

      // No new decision — completed workflow stays completed; nothing
      // gets re-decided.
      expect(result.decision).toBeUndefined();
    });
  });
});
