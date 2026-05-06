/**
 * activation-nudge.ts — Lifecycle CRM activation nudge workflow template (S4.7)
 *
 * Workflow template: `activation-nudge`
 *
 * ## Purpose
 *   Detect users who have NOT activated within a configurable window after
 *   first contact, and send them a nudge email + log a note in the CRM.
 *
 * ## Trigger
 *   Schedule: every 6 hours, scan for unactivated users (configurable via config)
 *   - Reads events table: `event_name='identify'` in the past 7 days
 *   - Extracts userId from event payload.distinctId (PostHog contract)
 *   - Filters: no corresponding `event_name='activated'` from the same distinctId
 *   - Applies dedup: user has not been nudged in the past 14 days
 *
 * ## Config shape
 *   {
 *     activationEventName?: string;      // defaults to 'activated'
 *     inactivityWindow?: number;          // days (default 7)
 *     dedupWindow?: number;               // days (default 14)
 *     nudgeEmailSubject?: string;         // template string with {firstName}, {productName}
 *   }
 *
 * ## Execution flow
 *   1. scanUnactivatedUsers(db, companyId, config)
 *      → finds N unactivated events within the inactivityWindow
 *      → filters out events with activation, or where no contact is available
 *      → returns array of { eventId, distinctId, email, ... }
 *
 *   2. For each unactivated event:
 *      → sendActivationNudgeEmail(event, companyConfig)
 *      → createHubSpotNote(distinctId, "Re-engagement nudge sent")
 *      → emits workflow action with status: "completed"
 *
 *   3. Autonomy gate: checked at SEND time via canRunAutonomously()
 *      - If autonomyLevel=3: actions stay "pending", run pauses pending_approval
 *      - If autonomyLevel=4 + flag enabled: send immediately
 *      - If autonomyLevel<=2: drafts are created; founder acts manually
 *
 * ## Dedup contract
 *   Dedup key: { distinctId, workflowId, companyId }
 *   Uses workflowRuns.actions[] to track "nudge_sent" for each distinctId in this run.
 *   Prevents re-nudging the same user twice within dedupWindow.
 *
 * ## Test categories
 *   - Registration: template is registered in WORKFLOW_TEMPLATES
 *   - Scan logic: scanUnactivatedUsers returns correct set
 *   - Dedup: users nudged in a previous run are skipped
 *   - Gating: autonomyLevel gates the send (draft vs approval vs autonomous)
 *   - Cross-tenant: company A workflows don't see company B users
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  events,
  workflowRuns,
  type Workflow,
  type WorkflowAction,
  type WorkflowRun,
} from "@founderos/db";
import { canRunAutonomously } from "../../workflow-autonomy.js";
import { isDraftOnly, requiresApproval } from "../../workflow-autonomy.js";
import { getEmailTransport } from "../../transports/email-transport.js";
import { logger } from "../../../middleware/logger.js";
import { isSuppressed } from "../../customer-email-suppressions.js";
import { buildUnsubscribeUrl } from "../../email-unsubscribe-tokens.js";

// ── Config schema (inferred from config JSONB) ──────────────────────────────

export interface ActivationNudgeConfig {
  /** Event name that signals successful activation (default: 'activated') */
  activationEventName?: string;
  /** Inactivity window in days (default: 7) */
  inactivityWindow?: number;
  /** Dedup window in days (default: 14) */
  dedupWindow?: number;
  /** Email subject template with {firstName} and {productName} placeholders */
  nudgeEmailSubject?: string;
}

// ── Event candidate for nudge ────────────────────────────────────────────────

export interface UnactivatedEventCandidate {
  eventId: string;
  distinctId: string;
  email: string | null;
  companyId: string;
  identifiedAt: Date;
}

// ── Scan for unactivated users ──────────────────────────────────────────────

/**
 * scanUnactivatedUsers — find users who have NOT activated within N days.
 *
 * Query strategy:
 *   - Find all events with event_name='identify' in the past inactivityWindow days
 *   - Extract distinctId from payload.distinctId (PostHog contract)
 *   - Filter out any distinctId with a corresponding event_name='activated'
 *   - Return sorted by occurredAt (oldest first → prioritize long-inactive)
 *
 * @param db         Drizzle DB handle
 * @param companyId  Company to scan (tenant isolation)
 * @param config     Template config (defaults applied here)
 * @returns Array of unactivated events, oldest first
 */
export async function scanUnactivatedUsers(
  db: Db,
  companyId: string,
  config: ActivationNudgeConfig = {},
): Promise<UnactivatedEventCandidate[]> {
  const activationEventName = config.activationEventName ?? "activated";
  const inactivityWindow = config.inactivityWindow ?? 7;

  const now = new Date();
  const cutoff = new Date(now.getTime() - inactivityWindow * 24 * 60 * 60 * 1000);

  // Find identify events in the window
  const identifyEvents = await db
    .select({
      id: events.id,
      companyId: events.companyId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.eventName, "identify"),
        gte(events.occurredAt, cutoff),
      ),
    );

  // Get all activation events for this company
  const activationEvents = await db
    .select({ id: events.id, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.companyId, companyId),
        eq(events.eventName, activationEventName),
      ),
    );

  // Extract distinct IDs from activation events
  const activatedDistinctIds = new Set<string>();
  for (const evt of activationEvents) {
    const distinctId = (evt.payload as Record<string, unknown>)?.distinctId as string | null;
    if (distinctId) {
      activatedDistinctIds.add(distinctId);
    }
  }

  // For each identify event, check if the distinctId has activated
  // If not, include in results
  const unactivated: UnactivatedEventCandidate[] = [];
  const seenDistinctIds = new Set<string>();

  for (const event of identifyEvents) {
    // Extract distinctId from payload (PostHog pattern)
    const distinctId = (event.payload as Record<string, unknown>)?.distinctId as string | null;
    if (!distinctId || seenDistinctIds.has(distinctId)) continue;
    seenDistinctIds.add(distinctId);

    // Only include if this distinctId hasn't activated
    if (!activatedDistinctIds.has(distinctId)) {
      const email = (event.payload as Record<string, unknown>)?.email as string | null;
      unactivated.push({
        eventId: event.id,
        distinctId,
        email,
        companyId: event.companyId,
        identifiedAt: event.occurredAt as Date,
      });
    }
  }

  // Sort by identifiedAt (oldest first)
  unactivated.sort((a, b) => (a.identifiedAt.getTime() - b.identifiedAt.getTime()));

  return unactivated;
}

// ── Dedup check ──────────────────────────────────────────────────────────────

/**
 * hasBeenNudgedRecently — check if a distinctId has been nudged in the past N days.
 *
 * Queries workflow_runs.actions[] to find a "nudge_sent" action for this distinctId
 * and workflow in the dedupWindow.
 *
 * @param db           Drizzle DB handle
 * @param distinctId   PostHog distinct ID to check
 * @param workflowId   Workflow instance
 * @param dedupDays    Window (default 14)
 * @returns true if a recent nudge was already sent
 */
export async function hasBeenNudgedRecently(
  db: Db,
  distinctId: string,
  workflowId: string,
  dedupDays: number = 14,
): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - dedupDays * 24 * 60 * 60 * 1000);

  // Query using Drizzle's raw SQL for JSONB array search
  // Search for nudge_sent actions that match this distinctId in the dedup window.
  // Use array_agg with EXISTS to search within the actions array for a matching object.
  const rows = await db.execute(
    sql`SELECT id FROM workflow_runs
       WHERE workflow_id = ${workflowId}
       AND actions @> ${JSON.stringify([{ type: "nudge_sent", payload: { distinctId } }])}::jsonb
       AND created_at >= ${cutoff.toISOString()}
       LIMIT 1`,
  );

  return rows.length > 0;
}

// ── Build nudge actions ──────────────────────────────────────────────────────

/**
 * buildNudgeActions — create the array of workflow actions for the nudge run.
 *
 * For each unactivated event, produces actions:
 *   - type: "send_email", payload: { distinctId, email, subject, ... }
 *   - type: "log_crm_note", payload: { distinctId, subject: "Re-engagement nudge" }
 *   - type: "nudge_sent" (dedup marker)
 *
 * @param candidates   Events to nudge
 * @param config       Template config
 * @returns Array of WorkflowAction
 */
export function buildNudgeActions(
  candidates: UnactivatedEventCandidate[],
  config: ActivationNudgeConfig = {},
): WorkflowAction[] {
  const actions: WorkflowAction[] = [];

  for (const event of candidates) {
    // Email action
    const emailSubject =
      config.nudgeEmailSubject ??
      "We miss you! Here's what's new in {productName}";

    actions.push({
      type: "send_email",
      payload: {
        distinctId: event.distinctId,
        email: event.email,
        subject: emailSubject.replace("{productName}", "FounderOS"),
        template: "activation-nudge",
      },
      status: "pending",
    });

    // CRM note action
    actions.push({
      type: "log_crm_note",
      payload: {
        distinctId: event.distinctId,
        subject: "Re-engagement nudge sent",
      },
      status: "pending",
    });

    // Dedup marker
    actions.push({
      type: "nudge_sent",
      payload: {
        distinctId: event.distinctId,
      },
      status: "pending",
    });
  }

  return actions;
}

// ── Check autonomy and execution gate ────────────────────────────────────────

/**
 * shouldExecuteNudge — determine if the nudge should send based on autonomy level.
 *
 * - autonomyLevel <= 2 (draft): returns false → actions stay pending, manual
 * - autonomyLevel = 3 (approval): returns false → actions pending, awaits approval
 * - autonomyLevel = 4 (autonomous): returns true → send immediately
 *
 * IMPORTANT: The caller MUST have already checked canRunAutonomously() if the
 * workflow is level 4 — this function only interprets the autonomyLevel enum.
 *
 * @param workflow   The workflow (must include autonomyLevel)
 * @returns true if email should be sent immediately
 */
export function shouldExecuteNudge(workflow: Pick<Workflow, "autonomyLevel">): boolean {
  return !isDraftOnly(workflow) && !requiresApproval(workflow);
}

// ── Execute nudge actions (stub for integration) ────────────────────────────

/**
 * executeNudgeActions — carry out send_email + log_crm_note + nudge_sent actions.
 *
 * Council 2026-05-05 W0.2 BLOCK fix: replaced the v1 stub (which marked every
 * action "completed" regardless of outcome) with real per-action dispatch.
 *
 * Per-action behavior:
 *   - "send_email"     → transport.send(); failure stamps status="failed" + error
 *   - "log_crm_note"   → still a no-op stub (HubSpot integration deferred to S4.10)
 *   - "nudge_sent"     → bookkeeping marker, always "completed"
 *
 * If a send_email fails, the matching downstream log_crm_note + nudge_sent
 * for the SAME distinctId are still marked completed — the dedup marker is
 * needed to prevent retry storms. The send failure is the audit signal.
 *
 * @param actions   Workflow actions to execute
 * @param workflow  The workflow row — id is threaded into Resend tags
 * @param runId     The workflow_run id — threaded into Resend tags
 * @returns Updated actions with per-action status (completed | failed)
 */
export async function executeNudgeActions(
  actions: WorkflowAction[],
  workflow?: Pick<Workflow, "id">,
  runId?: string,
  // Optional db + companyId for the customer-email-suppressions gate.
  // Production callers (executeActivationNudgeTemplate) pass both. Legacy tests
  // that exercise executeNudgeActions in isolation can omit them — the gate
  // simply doesn't fire (preserves the pre-#196 contract for those tests). The
  // production callsite is the trust boundary that matters; new test
  // coverage of the gate lives in onboarding-emails-suppression.test.ts and
  // its activation-nudge counterpart.
  db?: Db,
  companyId?: string,
): Promise<WorkflowAction[]> {
  const transport = getEmailTransport();
  const fromAddress =
    process.env.FOUNDEROS_EMAIL_FROM ?? "FounderOS <onboarding@founderos.io>";
  const now = () => new Date().toISOString();
  const baseUrl = process.env.APP_URL ?? "https://founderos.io";

  const out: WorkflowAction[] = [];

  for (const action of actions) {
    if (action.type === "send_email") {
      const payload = action.payload as Record<string, unknown>;
      const to = (payload.email ?? payload.recipientEmail) as string | undefined;
      const subject = (payload.subject ?? "We miss you!") as string;

      if (!to) {
        logger.warn(
          { workflowId: workflow?.id, runId, payload },
          "activation-nudge send_email skipped — no recipient email in payload",
        );
        out.push({
          ...action,
          status: "failed",
          error: "no recipient email",
          executedAt: now(),
        });
        continue;
      }

      // Suppression gate (#196 layer 3d). Only fires when both db + companyId
      // are passed — production always passes them; some unit tests exercise
      // the function bare-bones and skip the gate intentionally.
      if (db && companyId) {
        const suppressed = await isSuppressed(
          db,
          companyId,
          to,
          "activation_nudge",
        );
        if (suppressed) {
          logger.info(
            { workflowId: workflow?.id, runId, to },
            "activation-nudge email skipped — recipient is suppressed",
          );
          out.push({
            ...action,
            status: "skipped",
            executedAt: now(),
            payload: { ...payload, skipReason: "customer_email_suppressed" },
          });
          continue;
        }
      }

      // CAN-SPAM unsubscribe URL — built per send because activation-nudge
      // candidates are independent (different recipients per scan tick).
      // Only generated when db + companyId are present (i.e. production
      // path). When absent, fall back to body without footer (existing
      // unit-test contract).
      let unsubscribeUrl: string | null = null;
      if (db && companyId) {
        unsubscribeUrl = buildUnsubscribeUrl(baseUrl, {
          c: companyId,
          e: to.toLowerCase(),
          t: "activation_nudge",
          ts: Date.now(),
        });
      }

      const text =
        ((payload.bodyText as string | undefined) ??
          `Hey — we noticed you haven't been back in a while. ${subject}`) +
        (unsubscribeUrl
          ? `\n\n—\nTo unsubscribe from these emails: ${unsubscribeUrl}`
          : "");
      const html =
        ((payload.bodyHtml as string | undefined) ??
          `<p>Hey — we noticed you haven't been back in a while.</p><p>${subject}</p>`) +
        (unsubscribeUrl
          ? `<hr style="margin-top:32px;border:none;border-top:1px solid #eee"><p style="font-size:12px;color:#999"><a href="${unsubscribeUrl}" style="color:#999;text-decoration:underline">Unsubscribe</a></p>`
          : "");

      const tags: Array<{ name: string; value: string }> = [
        { name: "template", value: "activation-nudge" },
      ];
      if (workflow?.id) tags.push({ name: "workflow_id", value: workflow.id });
      if (runId) tags.push({ name: "workflow_run_id", value: runId });
      if (typeof payload.distinctId === "string") {
        tags.push({ name: "distinct_id", value: payload.distinctId });
      }

      const result = await transport.send({
        to,
        from: fromAddress,
        subject,
        text,
        html,
        tags,
      });

      if (result.status === "failed") {
        logger.error(
          { workflowId: workflow?.id, runId, to, reason: result.reason },
          "activation-nudge email send failed",
        );
        out.push({
          ...action,
          status: "failed",
          error: result.reason ?? "transport rejected",
          executedAt: now(),
          payload: { ...payload, transportMode: transport.mode },
        });
      } else {
        out.push({
          ...action,
          status: "completed",
          executedAt: now(),
          payload: {
            ...payload,
            providerMessageId: result.id,
            transportMode: transport.mode,
          },
        });
      }
    } else {
      // log_crm_note + nudge_sent: bookkeeping. HubSpot integration is a
      // separate ticket (S4.10 CRM Console UI consolidation, task #167).
      out.push({
        ...action,
        status: "completed" as const,
        executedAt: now(),
      });
    }
  }

  return out;
}

/**
 * executeActivationNudgeTemplate — main dispatcher entry point
 * ============================================================
 *
 * Council R1 close-out P1 (2026-05-05 fix-the-fix) — without this wrapper,
 * the dispatcher in `services/workflows.ts` falls through to its `default`
 * branch when a workflow.template === "activation-nudge" run is created,
 * silently leaving the run stuck at `running` forever. Codex flagged this
 * in the Wave 0 close-out council — verified by inspecting the switch at
 * services/workflows.ts:334 (only `onboarding-emails` and `upsell` were
 * wired pre-fix).
 *
 * Architectural note: activation-nudge differs from onboarding-emails and
 * upsell in that its actions are PRE-STAMPED on the workflow_run by the
 * upstream scheduler (S4.7 trigger: scan unactivated → dedup → build action
 * list). The scheduler integration lives outside this file. This wrapper
 * therefore reads `workflowRun.actions` rather than building actions from
 * `workflow.config` like the other two templates.
 *
 * If a run lands here with no pre-stamped actions, that's a contract bug
 * upstream — fail-fast with a clear error rather than masking it.
 *
 * @param db          Drizzle handle
 * @param workflow    The workflow row (template='activation-nudge')
 * @param workflowRun The newly-created workflow_run row (actions pre-stamped)
 */
export async function executeActivationNudgeTemplate(
  db: Db,
  workflow: Workflow,
  workflowRun: WorkflowRun,
): Promise<void> {
  const workflowId = workflow.id;
  const runId = workflowRun.id;

  // Read pre-stamped actions from the run.
  const incoming = (workflowRun.actions as unknown as WorkflowAction[]) ?? [];
  if (!Array.isArray(incoming) || incoming.length === 0) {
    logger.error(
      { workflowId, runId },
      "activation-nudge run has no pre-stamped actions — scheduler contract bug",
    );
    // workflow_runs has no `error` column — errors are persisted as a
    // synthetic failed action in the actions[] jsonb (matches the existing
    // upsell.ts / onboarding-emails.ts pattern).
    await setActivationRunStatus(db, runId, "failed", {
      actions: [
        {
          type: "send_email",
          payload: {},
          status: "failed",
          error:
            "activation-nudge expects actions to be pre-stamped by the scan/trigger upstream; received empty actions[]",
        } as unknown as WorkflowAction,
      ],
    });
    return;
  }

  // Autonomy gate — this is the SAME gate that onboarding-emails / upsell
  // use, just adapted to the pre-stamped-actions shape.
  const canRun = await canRunAutonomously(db, workflow);

  if (!canRun) {
    // Draft-only or requires-approval: leave actions pending; the founder
    // (or approval flow) will dispatch them later. This matches upsell's
    // pending_approval branch.
    logger.info(
      { workflowId, runId, autonomyLevel: workflow.autonomyLevel },
      "activation-nudge gated to pending_approval (autonomyLevel<4 or flag off)",
    );
    await setActivationRunStatus(db, runId, "pending_approval", {
      actions: incoming,
    });
    return;
  }

  // Autonomous send.
  logger.info(
    { workflowId, runId, actionCount: incoming.length },
    "activation-nudge autonomous send triggered",
  );
  const executed = await executeNudgeActions(
    incoming,
    workflow,
    runId,
    db,
    workflow.companyId,
  );

  const anyFailed = executed.some((a) => a.status === "failed");
  const runStatus = anyFailed ? "failed" : "completed";
  await setActivationRunStatus(db, runId, runStatus, { actions: executed });
}

/**
 * Internal status writer. Kept private to this file so the activation-nudge
 * dispatcher contract stays compact; mirrors the pattern in
 * onboarding-emails.ts / upsell.ts (each owns its own status writer).
 */
async function setActivationRunStatus(
  db: Db,
  runId: string,
  status: "completed" | "failed" | "pending_approval",
  patch: { actions: WorkflowAction[] },
): Promise<void> {
  const completedAt =
    status === "completed" || status === "failed" ? new Date() : null;
  await db
    .update(workflowRuns)
    .set({
      status,
      actions: patch.actions as unknown as WorkflowRun["actions"],
      ...(completedAt !== null ? { completedAt } : {}),
    })
    .where(eq(workflowRuns.id, runId));
}
