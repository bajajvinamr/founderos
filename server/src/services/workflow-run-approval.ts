/**
 * workflow-run-approval.ts — S4.8 prerequisite #194.
 *
 * State machine for the workflow_run approval lifecycle. Council 2026-05-06
 * finding #4 mandates an explicit approveWorkflowRun() state machine for
 * customer-facing autonomous templates (churn-rescue first), so:
 *   - illegal transitions are rejected at service-layer, not by silent UPDATE
 *   - terminal states (completed / failed / rejected) cannot be re-decided
 *   - idempotent re-approval is a no-op (returns existing approved row)
 *   - the decision is auditable via activity_log
 *
 * ## State graph
 *
 *   pending → pending_approval (template gates on autonomyLevel<4)
 *           → completed         (autonomous path; no human in loop)
 *
 *   pending_approval → approved  (human approves; dispatch begins)
 *                    → rejected  (human declines; terminal)
 *
 *   approved → completed (dispatch ok; or already-completed if no actions)
 *            → failed    (dispatch error)
 *
 *   completed | failed | rejected → terminal
 *
 * Anything else throws InvalidWorkflowRunTransitionError.
 *
 * ## Why a separate service from approvals.ts
 *
 * approvals.ts handles the GENERIC `approvals` table (hire decisions, budget
 * overrides, plugin installs). workflow_runs has its own status field +
 * lifecycle that doesn't map cleanly to the generic approval row shape. A
 * separate state-machine service per resource keeps the contracts tight.
 *
 * ## Approval ↔ dispatch coupling
 *
 * approveWorkflowRun() does NOT directly invoke the template dispatcher —
 * it transitions status and emits a "ready" signal (activity_log entry +
 * returned WorkflowRun). The caller (likely an HTTP route in approvals.ts
 * or a worker tick) is responsible for re-executing the template once the
 * status is `approved`. This keeps the state machine pure and avoids
 * cross-cutting transactional concerns.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { workflowRuns, type WorkflowRun, type WorkflowRunStatus } from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

// ── Error types ────────────────────────────────────────────────────────────

export class WorkflowRunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`workflow-run-approval: workflow_run ${runId} not found`);
    this.name = "WorkflowRunNotFoundError";
  }
}

export class InvalidWorkflowRunTransitionError extends Error {
  constructor(
    public readonly runId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `workflow-run-approval: cannot transition workflow_run ${runId} ` +
        `from "${from}" to "${to}" (illegal state transition)`,
    );
    this.name = "InvalidWorkflowRunTransitionError";
  }
}

// ── Result types ───────────────────────────────────────────────────────────

export type ApprovalResult =
  | { applied: true; run: WorkflowRun }
  // applied=false means the request was idempotent: the run was ALREADY in
  // the requested state. Caller can render success without dispatch.
  | { applied: false; run: WorkflowRun; reason: "already_in_target_state" };

// ── State graph ────────────────────────────────────────────────────────────

const APPROVABLE_FROM: WorkflowRunStatus[] = ["pending_approval"];
const REJECTABLE_FROM: WorkflowRunStatus[] = ["pending_approval"];
const TERMINAL_STATES: WorkflowRunStatus[] = [
  "completed",
  "failed",
  "rejected",
];

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * approveWorkflowRun — pending_approval → approved.
 *
 * Allowed only from `pending_approval`. Idempotent re-approve on already-
 * `approved` returns applied=false. Re-approve on terminal state throws.
 *
 * @param db                Drizzle handle
 * @param runId             workflow_run.id
 * @param decidedByUserId   actor id from request context
 * @param decisionNote      optional human note attached to activity_log
 */
export async function approveWorkflowRun(
  db: Db,
  runId: string,
  decidedByUserId: string,
  decisionNote?: string,
): Promise<ApprovalResult> {
  return transitionWorkflowRun(db, {
    runId,
    decidedByUserId,
    decisionNote,
    targetStatus: "approved",
    allowedFrom: APPROVABLE_FROM,
    activityAction: "workflow_run_approved",
  });
}

/**
 * rejectWorkflowRun — pending_approval → rejected.
 *
 * Mirror of approveWorkflowRun. Terminal: cannot be un-rejected.
 */
export async function rejectWorkflowRun(
  db: Db,
  runId: string,
  decidedByUserId: string,
  decisionNote?: string,
): Promise<ApprovalResult> {
  return transitionWorkflowRun(db, {
    runId,
    decidedByUserId,
    decisionNote,
    targetStatus: "rejected",
    allowedFrom: REJECTABLE_FROM,
    activityAction: "workflow_run_rejected",
  });
}

/**
 * isTerminalWorkflowRunStatus — convenience for callers that want to check
 * whether a run can still be acted on.
 */
export function isTerminalWorkflowRunStatus(
  status: WorkflowRunStatus,
): boolean {
  return TERMINAL_STATES.includes(status);
}

// ── Internal: shared transition logic ──────────────────────────────────────

async function transitionWorkflowRun(
  db: Db,
  args: {
    runId: string;
    decidedByUserId: string;
    decisionNote?: string;
    targetStatus: WorkflowRunStatus;
    allowedFrom: WorkflowRunStatus[];
    activityAction: string;
  },
): Promise<ApprovalResult> {
  const { runId, decidedByUserId, decisionNote, targetStatus, allowedFrom, activityAction } = args;

  // Read current state (within a transaction so the FOR UPDATE lock blocks
  // concurrent transitions).
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .for("update");

    if (!current) {
      throw new WorkflowRunNotFoundError(runId);
    }

    // Idempotent re-decision: already in target state.
    if (current.status === targetStatus) {
      return { applied: false, run: current, reason: "already_in_target_state" } as const;
    }

    // Illegal transition.
    if (!allowedFrom.includes(current.status)) {
      throw new InvalidWorkflowRunTransitionError(
        runId,
        current.status,
        targetStatus,
      );
    }

    // Apply transition.
    const [updated] = await tx
      .update(workflowRuns)
      .set({
        status: targetStatus,
        // workflow_runs has no decided_by column today; persist the decision
        // metadata in actions[]. Schema augmentation deferred to a follow-up.
        // For now the activity_log row IS the audit trail.
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          inArray(workflowRuns.status, allowedFrom),
        ),
      )
      .returning();

    if (!updated) {
      // Race: another tx changed status between SELECT FOR UPDATE and UPDATE.
      // Re-read to surface the actual state.
      const [latest] = await tx
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId));
      throw new InvalidWorkflowRunTransitionError(
        runId,
        latest?.status ?? "unknown",
        targetStatus,
      );
    }

    // Audit trail: activity_log row.
    await logActivity(tx as unknown as Db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: activityAction,
      entityType: "workflow_run",
      entityId: updated.id,
      workflowId: updated.workflowId,
      details: {
        from: current.status,
        to: targetStatus,
        decisionNote: decisionNote ?? null,
      },
    });

    logger.info(
      {
        runId,
        from: current.status,
        to: targetStatus,
        decidedByUserId,
      },
      "workflow-run-approval: transition applied",
    );

    return { applied: true, run: updated } as const;
  });
}
