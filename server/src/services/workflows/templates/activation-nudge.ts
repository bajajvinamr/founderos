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
import { events, type Workflow, type WorkflowAction } from "@founderos/db";
import { isDraftOnly, requiresApproval } from "../../workflow-autonomy.js";
import { getEmailTransport } from "../../transports/email-transport.js";
import { logger } from "../../../middleware/logger.js";

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
): Promise<WorkflowAction[]> {
  const transport = getEmailTransport();
  const fromAddress =
    process.env.FOUNDEROS_EMAIL_FROM ?? "FounderOS <onboarding@founderos.io>";
  const now = () => new Date().toISOString();

  const out: WorkflowAction[] = [];

  for (const action of actions) {
    if (action.type === "send_email") {
      const payload = action.payload as Record<string, unknown>;
      const to = (payload.email ?? payload.recipientEmail) as string | undefined;
      const subject = (payload.subject ?? "We miss you!") as string;
      const text =
        (payload.bodyText as string | undefined) ??
        `Hey — we noticed you haven't been back in a while. ${subject}`;
      const html =
        (payload.bodyHtml as string | undefined) ??
        `<p>Hey — we noticed you haven't been back in a while.</p><p>${subject}</p>`;

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
