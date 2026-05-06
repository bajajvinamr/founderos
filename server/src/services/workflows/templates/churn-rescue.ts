/**
 * churn-rescue.ts — S4.8 demo ticket: autonomous churn-rescue email flow.
 *
 * Trigger: Stripe `customer.subscription.deleted` event OR scheduled scan
 *          for accounts that crossed a churn-risk threshold.
 *
 * Action shape per workflow_run: 1 send_email per recipient with a Stripe
 * coupon-redemption URL, suppression-pre-filtered, recipient-capped at 50/day.
 *
 * ## Composition over re-implementation (council 2026-05-06 finding #4)
 *
 * This template is a thin composition layer over the 8 prereqs that close
 * the council's BLOCK list:
 *
 *   #192 idempotency keys              → consumed by route layer (not here)
 *   #193 PII allowlist                 → extractAllowedCategory() on payload
 *   #194 approval state machine        → approvedWorkflowRun called by route
 *   #195 recipient materialization     → materializeRecipients()
 *   #196 customer email suppressions   → loadSuppressedEmails inside #195
 *                                        + per-recipient isSuppressed gate
 *   #197 email-wrapper compliance      → wrapEmailForCompliance()
 *   #198 typed connectedAccountId      → resolveConnectedAccountId() persisted
 *                                        on action.payload at run creation
 *   #199 per-tenant rate limit         → assertWorkflowRunRateLimit on the
 *                                        creation route, not here
 *
 * The template's own logic is narrow:
 *   - Per-recipient: build subject + body with a coupon URL
 *   - Apply CAN-SPAM wrapper (#197)
 *   - Pre-send isSuppressed gate (defense in depth: cohort was already filtered)
 *   - Send via transport, persist per-action result
 *
 * ## Why no LLM call here
 *
 * The council finding #4 mandates: generation happens at run-CREATION time,
 * not run-EXECUTION time. The founder approves a frozen email body. Doing
 * LLM generation here would re-roll the copy on every retry and the
 * approved-vs-sent diff would diverge. Generation lives in
 * `churn-rescue-generator.ts` (called by the route layer at create time);
 * this file only consumes the pre-rendered actions array.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { workflowRuns, type Workflow, type WorkflowRun } from "@founderos/db";
import { logger } from "../../../middleware/logger.js";
import { canRunAutonomously } from "../../workflow-autonomy.js";
import { logActivity } from "../../activity-log.js";
import { getEmailTransport } from "../../transports/email-transport.js";
import {
  loadComplianceContextForCompany,
  wrapEmailForCompliance,
  type ComplianceContext,
} from "../../transports/email-wrapper.js";
import { isSuppressed } from "../../customer-email-suppressions.js";
import { buildUnsubscribeUrl } from "../../email-unsubscribe-tokens.js";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Persisted on workflow.config at create time. Rendered email bodies live
 * on workflow_run.actions[*].payload — this is just the per-tenant config.
 */
export interface ChurnRescueConfig {
  /** From-address override; falls back to FOUNDEROS_EMAIL_FROM. */
  fromAddress?: string;
  /** Optional Stripe coupon code embedded in CTA URL (e.g., "RESCUE25"). */
  couponCode?: string;
  /** Where the CTA link points (typically the billing page or a re-subscribe flow). */
  rescueUrl?: string;
  /** Free-form copy hint passed through to the generator at create time. */
  copyHint?: string;
}

/**
 * Per-action shape persisted on workflow_run.actions[i]. Pre-stamped at
 * run creation by the generator; this template just dispatches each.
 */
export interface ChurnRescueAction {
  type: "send_email";
  payload: {
    recipientEmail: string;
    recipientName?: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    /** From #198 — resolved at run creation, persisted for cross-org safety. */
    connectedAccountId?: string;
    /** Provider message id for Resend webhook reconciliation. */
    providerMessageId?: string;
    /** Transport mode tag — "resend" / "capture" — for observability. */
    transportMode?: string;
    /** Set on a skipped action (suppression hit at send time). */
    skipReason?: string;
  };
  status: "pending" | "completed" | "failed" | "skipped";
  executedAt?: string;
  error?: string;
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * executeChurnRescueTemplate — main dispatcher.
 *
 * Reads pre-stamped actions off workflow_run.actions, applies autonomy gate
 * + per-recipient suppression check + CAN-SPAM wrapper, sends each via
 * the active EmailTransport, then persists per-action results.
 *
 * Council: this template treats `actions === []` at execute time as a
 * scheduler-contract bug, not a no-op. A run that reached "running" with
 * no actions means the route forgot to materialize the cohort. We mark
 * the run failed so it's visible in the activity log instead of silently
 * completing as if nothing happened.
 */
export async function executeChurnRescueTemplate(
  db: Db,
  workflow: Workflow,
  workflowRun: WorkflowRun,
): Promise<void> {
  const workflowId = workflow.id;
  const runId = workflowRun.id;

  const actions = (workflowRun.actions ?? []) as ChurnRescueAction[];
  if (actions.length === 0) {
    logger.error(
      { workflowId, runId },
      "churn-rescue run has no pre-stamped actions — scheduler contract bug",
    );
    await updateWorkflowRunStatus(db, runId, "failed", {
      error: "no actions to send — recipient materialization must run at create time",
    });
    return;
  }

  // CAN-SPAM context (#197). Single-row read; cached at template-scope.
  const complianceCtx = await loadComplianceContextForCompany(
    db,
    workflow.companyId,
  );
  if (!complianceCtx) {
    logger.error(
      { workflowId, runId, companyId: workflow.companyId },
      "churn-rescue: compliance context missing for company",
    );
    await updateWorkflowRunStatus(db, runId, "failed", {
      error: "compliance context not found for company",
    });
    return;
  }

  // Autonomy re-check at execute time. Founder may have flipped autonomy
  // off between approval and now. Same defense as upsell.ts.
  const canRun = await canRunAutonomously(db, workflow);
  const requiresApproval = workflow.autonomyLevel === 3;

  if (!canRun && !requiresApproval) {
    // autonomyLevel <= 2 (observe/draft) → leave actions in pending,
    // park the run as pending_approval for founder review.
    logger.info(
      { workflowId, runId, autonomyLevel: workflow.autonomyLevel },
      "churn-rescue draft-only; founder must trigger manually",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions });
    return;
  }

  if (requiresApproval && !canRun) {
    logger.info(
      { workflowId, runId },
      "churn-rescue approval-required; pending human sign-off",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions });
    return;
  }

  // Autonomous path: dispatch every action sequentially. Sequential
  // (not parallel) so a transport meltdown halts after the first failure
  // instead of fanning out 50 broken sends. Throughput at 50/day is fine
  // serial.
  logger.info(
    { workflowId, runId, recipientCount: actions.length },
    "churn-rescue autonomous send triggered",
  );

  const sentActions: ChurnRescueAction[] = [];
  for (const action of actions) {
    const sent = await sendOneChurnRescueEmail(
      db,
      workflow,
      runId,
      action,
      complianceCtx,
    );
    sentActions.push(sent);
  }

  // Run-level outcome:
  //   - any failed → run failed
  //   - all skipped (e.g., entire cohort suppressed) → run completed (no-op
  //     but visible)
  //   - some completed + some skipped → run completed
  const anyFailed = sentActions.some((a) => a.status === "failed");
  const runStatus = anyFailed ? "failed" : "completed";
  await updateWorkflowRunStatus(db, runId, runStatus, { actions: sentActions });

  await logActivity(db, {
    companyId: workflow.companyId,
    actorType: "system",
    actorId: "workflow-executor",
    action:
      runStatus === "failed"
        ? "churn_rescue_partial_failure"
        : "churn_rescue_completed",
    entityType: "workflow_run",
    entityId: runId,
    workflowId,
    details: {
      total: sentActions.length,
      completed: sentActions.filter((a) => a.status === "completed").length,
      skipped: sentActions.filter((a) => a.status === "skipped").length,
      failed: sentActions.filter((a) => a.status === "failed").length,
    },
  });
}

// ── Per-action send ────────────────────────────────────────────────────────

async function sendOneChurnRescueEmail(
  db: Db,
  workflow: Workflow,
  runId: string,
  action: ChurnRescueAction,
  complianceCtx: ComplianceContext,
): Promise<ChurnRescueAction> {
  const transport = getEmailTransport();
  const fromAddress =
    (workflow.config as ChurnRescueConfig)?.fromAddress ??
    process.env.FOUNDEROS_EMAIL_FROM ??
    "FounderOS <onboarding@founderos.io>";

  // Defense-in-depth: re-check suppression per recipient. The cohort was
  // already filtered at materializeRecipients() time, but a user may have
  // unsubscribed in the gap between approval and send (a Resend bounce
  // webhook just hit, etc).
  const suppressed = await isSuppressed(
    db,
    workflow.companyId,
    action.payload.recipientEmail,
    "churn_rescue",
  );
  if (suppressed) {
    logger.info(
      { workflowId: workflow.id, runId, to: action.payload.recipientEmail },
      "churn-rescue email skipped — recipient suppressed since approval",
    );
    return {
      ...action,
      status: "skipped",
      executedAt: new Date().toISOString(),
      payload: { ...action.payload, skipReason: "customer_email_suppressed" },
    };
  }

  // CAN-SPAM unsubscribe URL (#196 layer 2 + 3c-2 — HMAC stateless).
  const baseUrl = process.env.APP_URL ?? "https://founderos.io";
  const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, {
    c: workflow.companyId,
    e: action.payload.recipientEmail.toLowerCase(),
    t: "churn_rescue",
    ts: Date.now(),
  });

  // Compliance footer wrap (#197). Refuses to send if physicalAddress is
  // NULL — the safe direction for a CAN-SPAM gate.
  const wrapResult = wrapEmailForCompliance(
    {
      to: action.payload.recipientEmail,
      from: fromAddress,
      subject: action.payload.subject,
      text: action.payload.bodyText,
      html: action.payload.bodyHtml,
      tags: [
        { name: "workflow_id", value: workflow.id },
        { name: "workflow_run_id", value: runId },
        { name: "template", value: "churn-rescue" },
      ],
    },
    complianceCtx,
    unsubscribeUrl,
  );
  if (!wrapResult.ok) {
    logger.error(
      { workflowId: workflow.id, runId, reason: wrapResult.reason },
      "churn-rescue email send refused — compliance context missing physical_address",
    );
    return {
      ...action,
      status: "failed",
      error: `compliance_refused: ${wrapResult.reason}`,
      executedAt: new Date().toISOString(),
    };
  }

  logger.info(
    {
      workflowId: workflow.id,
      runId,
      to: action.payload.recipientEmail,
      mode: transport.mode,
    },
    "churn-rescue email dispatching",
  );

  const result = await transport.send(wrapResult.wrapped);

  if (result.status === "failed") {
    logger.error(
      {
        workflowId: workflow.id,
        runId,
        to: action.payload.recipientEmail,
        reason: result.reason,
      },
      "churn-rescue email send failed",
    );
    return {
      ...action,
      status: "failed",
      error: result.reason ?? "transport rejected",
      executedAt: new Date().toISOString(),
      payload: { ...action.payload, transportMode: transport.mode },
    };
  }

  return {
    ...action,
    status: "completed",
    executedAt: new Date().toISOString(),
    payload: {
      ...action.payload,
      providerMessageId: result.id,
      transportMode: transport.mode,
    },
  };
}

// ── Run status helper (matches sibling templates) ──────────────────────────

async function updateWorkflowRunStatus(
  db: Db,
  runId: string,
  status: string,
  metadata: { actions?: ChurnRescueAction[]; error?: string } = {},
): Promise<void> {
  const [currentRun] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId));

  if (!currentRun) {
    logger.error({ runId }, "workflow_run not found for status update");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { status };
  if (metadata.actions) {
    updates.actions = metadata.actions;
  }
  if (status === "completed" || status === "failed") {
    updates.completedAt = new Date();
  }
  await db
    .update(workflowRuns)
    .set(updates)
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.companyId, currentRun.companyId),
      ),
    );
}
