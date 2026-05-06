/**
 * workflow-autonomy.ts — Autonomy-gate decision logic for Lifecycle CRM (S4.5)
 *
 * This module is the single authoritative place for answering:
 *   "Can this workflow run without a human approval step?"
 *
 * ## Why two levels of gates?
 *
 *   GATE 1 — workflow.autonomyLevel (DB column, per-workflow setting)
 *     The founder configures each workflow with an autonomy level:
 *       1 = observe   — analyse only, never act
 *       2 = draft     — produce drafts; founder reviews before anything sends
 *       3 = approval  — queue an approvals row; human must approve each run
 *       4 = autonomous — execute immediately, no human in the loop
 *
 *   GATE 2 — instance_settings flag (per-instance, instance-admin must set)
 *     Even autonomyLevel=4 is blocked unless an instance admin has explicitly
 *     enabled `lifecycle_crm.allow_autonomous_email` in instance_settings.
 *     This is the "master switch" — it prevents a misconfigured autonomyLevel
 *     from silently sending thousands of emails.
 *
 * ## The invariant
 *   canRunAutonomously() returns true IF AND ONLY IF:
 *     (a) workflow.autonomyLevel === 4, AND
 *     (b) instanceSettings.general["lifecycle_crm.allow_autonomous_email"] === true
 *
 *   No other combination produces true. There is no COUNCIL_OVERRIDE escape
 *   hatch. There is no env-var bypass. The only way to get autonomous email
 *   is for a human to explicitly set both.
 *
 * ## requiresApproval()
 *   Returns true when autonomyLevel === 3 (approval-required). At this level
 *   the agent creates an approvals row and waits; canRunAutonomously() is false.
 *
 * ## isDraftOnly()
 *   Returns true when autonomyLevel <= 2. The agent produces output but nothing
 *   is sent — the founder must act manually.
 *
 * Council scrutiny note: the check in canRunAutonomously() deliberately reads
 * the flag from the live DB on every call (raw JSONB read from instance_settings)
 * rather than caching. This prevents a scenario where the flag is disabled in
 * prod but a cached value allows a window of autonomous sends. The cost is one
 * extra DB read per workflow run trigger — acceptable given the stakes.
 *
 * We read raw JSONB rather than going through instanceSettingsService.getGeneral()
 * because that normalizer strips unknown keys (it only returns the typed
 * InstanceGeneralSettings shape). The lifecycle CRM flag is a new domain key
 * that we intentionally keep separate from the core settings schema, so it must
 * be read directly from the JSONB column.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { AUTONOMY_LEVELS, instanceSettings, type Workflow } from "@founderos/db";

/** The instance_settings key that gates autonomous customer-facing email. */
export const AUTONOMOUS_EMAIL_SETTING_KEY = "lifecycle_crm.allow_autonomous_email";

/**
 * canRunAutonomously — the primary autonomy gate.
 *
 * Returns true only when BOTH conditions hold:
 *   1. workflow.autonomyLevel === 4
 *   2. instance_settings.general["lifecycle_crm.allow_autonomous_email"] === true
 *
 * Reads instance settings live from DB — not cached — so a flag flip takes
 * effect on the next call without requiring a server restart.
 *
 * @param db     Drizzle DB handle
 * @param workflow  The workflow row (must include autonomyLevel)
 * @returns boolean — true means the run may execute without human approval
 */
export async function canRunAutonomously(
  db: Db,
  workflow: Pick<Workflow, "autonomyLevel">,
): Promise<boolean> {
  // Gate 1: workflow-level setting must be 4.
  if (workflow.autonomyLevel !== AUTONOMY_LEVELS.AUTONOMOUS) {
    return false;
  }

  // Gate 2: instance admin must have explicitly enabled autonomous email.
  // Read raw JSONB — the typed normalizer (instanceSettingsService.getGeneral)
  // strips unknown keys, so we query the column directly.
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));

  const rawGeneral = (row?.general ?? {}) as Record<string, unknown>;
  const instanceFlag = rawGeneral[AUTONOMOUS_EMAIL_SETTING_KEY];
  return instanceFlag === true;
}

/**
 * requiresApproval — returns true when the run must pause for human sign-off.
 *
 * autonomyLevel === 3 means the agent queues an approvals row; execution is
 * blocked until a human approves via the approvals API.
 */
export function requiresApproval(workflow: Pick<Workflow, "autonomyLevel">): boolean {
  return workflow.autonomyLevel === AUTONOMY_LEVELS.APPROVAL_REQUIRED;
}

/**
 * isDraftOnly — returns true when the agent produces output but sends nothing.
 *
 * autonomyLevel 1 (observe) or 2 (draft) — the founder must act manually.
 * This is the default for all new workflows (DB default = 2).
 */
export function isDraftOnly(workflow: Pick<Workflow, "autonomyLevel">): boolean {
  return workflow.autonomyLevel <= AUTONOMY_LEVELS.DRAFT;
}

/**
 * describeAutonomyLevel — human-readable label for display and audit log.
 */
export function describeAutonomyLevel(level: number): string {
  switch (level) {
    case AUTONOMY_LEVELS.OBSERVE:          return "observe";
    case AUTONOMY_LEVELS.DRAFT:            return "draft";
    case AUTONOMY_LEVELS.APPROVAL_REQUIRED: return "approval-required";
    case AUTONOMY_LEVELS.AUTONOMOUS:       return "autonomous";
    default:                               return `unknown(${level})`;
  }
}

/**
 * autonomyGateSummary — returns a structured decision record for audit logs.
 * Callers should persist this into the activity_log details field whenever
 * a workflow run is triggered, so the decision is auditable post-hoc.
 */
export async function autonomyGateSummary(
  db: Db,
  workflow: Pick<Workflow, "id" | "autonomyLevel">,
): Promise<{
  workflowId: string;
  autonomyLevel: number;
  autonomyLabel: string;
  willRunAutonomously: boolean;
  requiresApprovalStep: boolean;
  isDraftOnlyMode: boolean;
}> {
  const willRunAutonomously = await canRunAutonomously(db, workflow);
  return {
    workflowId: workflow.id,
    autonomyLevel: workflow.autonomyLevel,
    autonomyLabel: describeAutonomyLevel(workflow.autonomyLevel),
    willRunAutonomously,
    requiresApprovalStep: requiresApproval(workflow),
    isDraftOnlyMode: isDraftOnly(workflow),
  };
}
