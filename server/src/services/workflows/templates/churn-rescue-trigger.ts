/**
 * churn-rescue-trigger.ts — S4.8 end-to-end orchestrator.
 *
 * The single entry point invoked by upstream triggers (Stripe webhook
 * receiver, scheduled scanner, manual founder action). Composes all 8
 * council prereqs into one transactional CREATE-WORKFLOW-RUN call:
 *
 *   1. assertWorkflowRunRateLimit (#199) — 50/day per tenant cap
 *   2. tryResolveConnectedAccountId (#198) — resolves "stripe" account if
 *      one exists (NULL is fine for the demo path; real Stripe coupon
 *      redemption goes through the user's already-attached billing UI)
 *   3. generateChurnRescueActions (#193 + #195) — materialize cohort,
 *      filter via suppressions, render per-category copy
 *   4. INSERT workflow_run with idempotency_key=externalEventId (#192) —
 *      retries on the same Stripe event_id are no-ops
 *   5. Per autonomy gate, status=running OR status=pending_approval
 *
 * Returns a tagged result so the caller (webhook receiver) can map to a
 * 2xx + structured response. Never throws on user-input errors — only
 * on programmer errors (invalid workflowId, missing company).
 *
 * ## Council finding #4 trace
 *
 * Every failure mode the council called out has a closed loop here:
 *   - Cohort drift between approval + send → cohort frozen at create time
 *   - Cancellation reason PII leak → enum-only, raw text never reaches body
 *   - Cross-tenant Composio leak → connectedAccountId resolved per-org
 *   - CAN-SPAM violation → wrapper enforces physical_address at SEND time
 *     (not here — handled by the dispatcher template)
 *   - Domain-rep blast at scale → 50/day cap, fail-loud above
 *   - Idempotent retry → externalEventId UNIQUE NULLS NOT DISTINCT
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  workflowRuns,
  workflows,
  type Workflow,
  type WorkflowRun,
} from "@founderos/db";
import { logger } from "../../../middleware/logger.js";
import { canRunAutonomously } from "../../workflow-autonomy.js";
import {
  assertWorkflowRunRateLimit,
  RateLimitExceededError,
} from "../../workflow-rate-limit.js";
import { tryResolveConnectedAccountId } from "../../composio-connection-resolver.js";
import {
  generateChurnRescueActions,
  type ChurnRescueCandidate,
  type ChurnRescueGeneratorResult,
} from "./churn-rescue-generator.js";
import type { ChurnRescueAction, ChurnRescueConfig } from "./churn-rescue.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface ChurnRescueTriggerInput {
  /** Tenant scope. Resolved upstream from the Stripe webhook source. */
  companyId: string;
  /** workflowId of the active churn-rescue workflow row for this tenant. */
  workflowId: string;
  /**
   * Idempotency key — Stripe event id, or a synthesized key for scanner
   * triggers (e.g. "scan:<companyId>:<dateBucket>"). Same key on retry =>
   * no-op.
   */
  externalEventId: string;
  /** Cancellation cohort. For Stripe webhook = 1 candidate; for scanner = N. */
  candidates: ChurnRescueCandidate[];
  /** Trigger source label for triggeredBy persistence. */
  triggerSource: "stripe" | "scheduler" | "manual";
  triggerEvent?: string;
}

export type ChurnRescueTriggerResult =
  | {
      ok: true;
      workflowRunId: string;
      status: "running" | "pending_approval";
      actionCount: number;
      counts: {
        candidates: number;
        materialized: number;
        droppedSuppressed: number;
        droppedInvalidEmail: number;
        droppedDuplicate: number;
        droppedOverCap: number;
      };
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      reason:
        | "workflow_not_found"
        | "workflow_wrong_template"
        | "workflow_paused"
        | "workflow_not_active"
        | "rate_limit_exceeded"
        | "empty_cohort"
        | "all_recipients_dropped";
      details?: Record<string, unknown>;
    };

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * triggerChurnRescue — orchestrate the full create-time pipeline.
 */
export async function triggerChurnRescue(
  db: Db,
  input: ChurnRescueTriggerInput,
): Promise<ChurnRescueTriggerResult> {
  const {
    companyId,
    workflowId,
    externalEventId,
    candidates,
    triggerSource,
    triggerEvent,
  } = input;

  // Step 0 — fetch workflow and validate. We pull tenant-scoped (and reject
  // any other tenant's row reaching us via input — defense in depth).
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)),
    );

  if (!workflow) {
    logger.warn(
      { workflowId, companyId },
      "churn-rescue trigger: workflow not found in this tenant",
    );
    return { ok: false, reason: "workflow_not_found" };
  }

  if (workflow.template !== "churn-rescue") {
    logger.warn(
      { workflowId, template: workflow.template },
      "churn-rescue trigger: workflow has wrong template",
    );
    return {
      ok: false,
      reason: "workflow_wrong_template",
      details: { template: workflow.template },
    };
  }

  if (workflow.status !== "active") {
    return {
      ok: false,
      reason:
        workflow.status === "paused" ? "workflow_paused" : "workflow_not_active",
      details: { status: workflow.status },
    };
  }

  // Step 1 — idempotency replay short-circuit (#192).
  // Same externalEventId on a Stripe-webhook retry => return the existing run
  // unchanged. No double-stamp, no duplicate emails. The DB UNIQUE NULLS
  // NOT DISTINCT constraint is the durable guard; this is the polite path.
  const [existingRun] = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.companyId, companyId),
        eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.idempotencyKey, externalEventId),
      ),
    );
  if (existingRun) {
    logger.info(
      {
        workflowId,
        runId: existingRun.id,
        externalEventId,
      },
      "churn-rescue trigger: idempotent replay — returning existing run",
    );
    return {
      ok: true,
      workflowRunId: existingRun.id,
      status: existingRun.status as "running" | "pending_approval",
      actionCount: ((existingRun.actions ?? []) as unknown[]).length,
      counts: {
        candidates: candidates.length,
        materialized: ((existingRun.actions ?? []) as unknown[]).length,
        droppedSuppressed: 0,
        droppedInvalidEmail: 0,
        droppedDuplicate: 0,
        droppedOverCap: 0,
      },
      idempotentReplay: true,
    };
  }

  // Step 2 — rate limit (#199). Throws RateLimitExceededError on cap hit.
  try {
    await assertWorkflowRunRateLimit(db, companyId, workflow.template);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      logger.warn(
        { workflowId, companyId, template: workflow.template },
        "churn-rescue trigger: daily cap hit — refusing to create run",
      );
      return {
        ok: false,
        reason: "rate_limit_exceeded",
        details: { template: workflow.template },
      };
    }
    throw err;
  }

  // Step 3 — empty input short-circuit. Don't burn a rate-limit slot on a
  // no-op trigger. (RateLimit was checked first to keep accounting honest:
  // a real-cohort retry isn't blocked by an empty earlier call.)
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: "empty_cohort" };
  }

  // Step 4 — resolve Composio Stripe connectedAccountId (#198). NULL is OK
  // here: the rescue email links to a coupon-redeem URL the user opens in
  // their browser, not a Composio API call. We stamp the resolved id on
  // the action.payload for downstream observability + future cross-org
  // safety guarantees.
  const stripeAccountId = await tryResolveConnectedAccountId(
    db,
    companyId,
    "stripe",
  );

  // Step 5 — generate the actions[] (#193 + #195 inside).
  const generated: ChurnRescueGeneratorResult = await generateChurnRescueActions(
    db,
    {
      companyId,
      candidates,
      config: workflow.config as ChurnRescueConfig,
    },
  );

  if (!generated.ok) {
    return {
      ok: false,
      reason:
        generated.reason === "empty_input"
          ? "empty_cohort"
          : "all_recipients_dropped",
      details: generated.details ?? {},
    };
  }

  // Step 6 — stamp the resolved Composio account id on each action so the
  // observability story stays intact even if a future variant calls Stripe
  // via Composio (refund flow, account update, etc).
  const actionsWithAccount: ChurnRescueAction[] = generated.actions.map(
    (a) => ({
      ...a,
      payload: {
        ...a.payload,
        ...(stripeAccountId ? { connectedAccountId: stripeAccountId } : {}),
      },
    }),
  );

  // Step 7 — autonomy gate decides initial status.
  let initialStatus: "running" | "pending_approval";
  if (workflow.autonomyLevel === 4) {
    const stillPermitted = await canRunAutonomously(db, workflow);
    initialStatus = stillPermitted ? "running" : "pending_approval";
  } else {
    initialStatus = "pending_approval";
  }

  // Step 8 — INSERT the workflow_run with pre-stamped actions and the
  // idempotency key set. UNIQUE NULLS NOT DISTINCT on
  // (companyId, workflowId, idempotencyKey) enforces single-creation.
  // Map upstream trigger source onto the workflow_runs.triggered_by.kind
  // enum which only accepts "event" | "schedule" | "manual" — Stripe webhook
  // = event; scheduler tick = schedule; founder = manual. The original
  // semantic source is preserved in `source`.
  const triggerKind: "event" | "schedule" | "manual" =
    triggerSource === "stripe"
      ? "event"
      : triggerSource === "scheduler"
        ? "schedule"
        : "manual";

  const [insertedRun] = await db
    .insert(workflowRuns)
    .values({
      companyId,
      workflowId,
      status: initialStatus,
      triggeredBy: {
        kind: triggerKind,
        source: triggerSource,
        ...(triggerEvent ? { event: triggerEvent } : {}),
        externalEventId,
      },
      actions: actionsWithAccount,
      idempotencyKey: externalEventId,
    })
    .returning();

  logger.info(
    {
      workflowId,
      runId: insertedRun.id,
      cohortSize: candidates.length,
      retained: actionsWithAccount.length,
      autonomyLevel: workflow.autonomyLevel,
      initialStatus,
    },
    "churn-rescue trigger: workflow_run created",
  );

  return {
    ok: true,
    workflowRunId: insertedRun.id,
    status: initialStatus,
    actionCount: actionsWithAccount.length,
    counts: {
      candidates: generated.counts.candidates,
      materialized: generated.counts.materialized,
      droppedSuppressed: generated.counts.droppedSuppressed,
      droppedInvalidEmail: generated.counts.droppedInvalidEmail,
      droppedDuplicate: generated.counts.droppedDuplicate,
      droppedOverCap: generated.counts.droppedOverCap,
    },
    idempotentReplay: false,
  };
}

// ── Helpers exported for tests ──────────────────────────────────────────────

export type { Workflow, WorkflowRun };
