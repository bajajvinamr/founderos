/**
 * workflows.ts — Lifecycle CRM workflow registry service (S4.5)
 *
 * All DB access for workflows and workflow_runs goes through this service.
 * Routes call the service; the service owns Drizzle queries.
 *
 * ## Drizzle invariant
 *   NEVER chain .where(a).where(b) — the second replaces the first silently.
 *   ALWAYS compose with .where(and(eq(...), eq(...))). This is the exact bug
 *   TC fixed in hubspot (commit 60a287c). Every filter predicate here uses
 *   the predicate-array pattern pioneered in experiments.ts.
 *
 * ## Tenant isolation
 *   Every query includes eq(workflows.companyId, companyId) in its predicate.
 *   Mutation operations re-fetch the row and verify companyId matches the
 *   caller's companyId before updating — same pattern as experiments.ts PATCH.
 *   workflowRuns also carries companyId and is filtered by it on every list.
 *
 * ## Audit log
 *   Every state-mutating operation emits an activityLog entry via logActivity.
 *   The workflowId column in activity_log (added in migration 0076) is used
 *   so CRM-specific activity can be filtered separately from general audit.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  workflows,
  workflowRuns,
  WORKFLOW_STATUSES,
  type Workflow,
  type WorkflowInsert,
  type WorkflowRun,
  type WorkflowRunInsert,
  type WorkflowStatus,
  type WorkflowRunStatus,
} from "@founderos/db";
import { logActivity } from "./activity-log.js";
import { executeOnboardingEmailTemplate } from "./workflows/templates/onboarding-emails.js";
import { executeUpsellTemplate } from "./workflows/templates/upsell.js";
import { logger } from "../middleware/logger.js";

// ── List / get ────────────────────────────────────────────────────────────────

export interface ListWorkflowsOptions {
  status?: WorkflowStatus;
  template?: string;
  limit?: number;
  offset?: number;
}

export async function listWorkflows(
  db: Db,
  companyId: string,
  opts: ListWorkflowsOptions = {},
): Promise<{ workflows: Workflow[]; total: number }> {
  const { status, template, limit = 50, offset = 0 } = opts;

  // Build predicate list — never chain .where(); always compose with and().
  const predicates = [eq(workflows.companyId, companyId)];
  if (status) predicates.push(eq(workflows.status, status));
  if (template) predicates.push(eq(workflows.template, template as Workflow["template"]));

  const rows = await db
    .select()
    .from(workflows)
    .where(and(...predicates))
    .orderBy(desc(workflows.createdAt))
    .limit(limit)
    .offset(offset);

  // Separate count query avoids a subquery; fine for the small row counts
  // expected in this table (tens of workflows per company, not millions).
  const countRows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(...predicates));

  return { workflows: rows, total: countRows.length };
}

export async function getWorkflow(
  db: Db,
  companyId: string,
  workflowId: string,
): Promise<Workflow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)));
  return row ?? null;
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreateWorkflowInput {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  data: Omit<WorkflowInsert, "id" | "companyId" | "createdAt" | "updatedAt">;
}

export async function createWorkflow(
  db: Db,
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const [row] = await db
    .insert(workflows)
    .values({
      ...input.data,
      companyId: input.companyId,
    })
    .returning();

  if (!row) throw new Error("Insert returned no row");

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    // Council 2026-05-06 P1 BLOCK fix — populate workflow_id (column added
    // in S1.8 migration 0076 but never set on writes). This makes the audit
    // trail filterable by workflow for incident response on autonomous sends.
    workflowId: row.id,
    action: "workflow.created",
    entityType: "workflow",
    entityId: row.id,
    details: {
      name: row.name,
      template: row.template,
      triggerKind: row.triggerKind,
      autonomyLevel: row.autonomyLevel,
      status: row.status,
    },
  });

  return row;
}

// ── Update ────────────────────────────────────────────────────────────────────

export interface UpdateWorkflowInput {
  companyId: string;
  workflowId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  /**
   * Partial update — only provided fields are written.
   * autonomyLevel changes are allowed here; the ROUTE layer is responsible for
   * verifying that autonomyLevel=4 is only accepted when the instance flag is
   * enabled (see workflow-autonomy.ts canRunAutonomously).
   */
  patch: Partial<Pick<
    Workflow,
    "name" | "status" | "autonomyLevel" | "triggerKind" | "triggerSpec" | "config"
  >>;
}

export async function updateWorkflow(
  db: Db,
  input: UpdateWorkflowInput,
): Promise<Workflow | null> {
  // Re-fetch with companyId to prevent cross-tenant mutation via known ID.
  const existing = await getWorkflow(db, input.companyId, input.workflowId);
  if (!existing) return null;

  const previousStatus = existing.status;
  const previousAutonomyLevel = existing.autonomyLevel;

  const [updated] = await db
    .update(workflows)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(and(eq(workflows.id, input.workflowId), eq(workflows.companyId, input.companyId)))
    .returning();

  if (!updated) return null;

  // Emit audit log for every update. Status transitions and autonomy-level
  // changes are flagged explicitly so the audit trail shows the lifecycle.
  const isStatusChange = input.patch.status !== undefined && input.patch.status !== previousStatus;
  const isAutonomyChange =
    input.patch.autonomyLevel !== undefined &&
    input.patch.autonomyLevel !== previousAutonomyLevel;

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    workflowId: updated.id,
    action: isStatusChange
      ? "workflow.status_changed"
      : isAutonomyChange
        ? "workflow.autonomy_changed"
        : "workflow.updated",
    entityType: "workflow",
    entityId: updated.id,
    details: {
      patch: input.patch,
      ...(isStatusChange && { previousStatus, newStatus: updated.status }),
      ...(isAutonomyChange && {
        previousAutonomyLevel,
        newAutonomyLevel: updated.autonomyLevel,
      }),
    },
  });

  return updated;
}

// ── workflow_runs ─────────────────────────────────────────────────────────────

export interface ListWorkflowRunsOptions {
  status?: WorkflowRunStatus;
  limit?: number;
  offset?: number;
}

export async function listWorkflowRuns(
  db: Db,
  companyId: string,
  workflowId: string,
  opts: ListWorkflowRunsOptions = {},
): Promise<{ runs: WorkflowRun[]; total: number }> {
  const { status, limit = 50, offset = 0 } = opts;

  const predicates = [
    eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.workflowId, workflowId),
  ];
  if (status) predicates.push(eq(workflowRuns.status, status));

  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(...predicates))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(...predicates));

  return { runs: rows, total: countRows.length };
}

export async function getWorkflowRun(
  db: Db,
  companyId: string,
  runId: string,
): Promise<WorkflowRun | null> {
  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId)));
  return row ?? null;
}

export interface CreateWorkflowRunInput {
  companyId: string;
  workflowId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  data: Omit<WorkflowRunInsert, "id" | "workflowId" | "companyId" | "createdAt">;
}

export async function createWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
): Promise<WorkflowRun> {
  const [run] = await db
    .insert(workflowRuns)
    .values({
      ...input.data,
      workflowId: input.workflowId,
      companyId: input.companyId,
    })
    .returning();

  if (!run) throw new Error("Insert returned no run row");

  // Update lastRunAt on the parent workflow.
  await db
    .update(workflows)
    .set({ lastRunAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflows.id, input.workflowId), eq(workflows.companyId, input.companyId)));

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    workflowId: input.workflowId,
    action: "workflow_run.created",
    entityType: "workflow_run",
    entityId: run.id,
    details: {
      workflowId: input.workflowId,
      status: run.status,
      triggeredBy: run.triggeredBy,
    },
  });

  return run;
}

// ── Template execution ───────────────────────────────────────────────────────────

/**
 * executeWorkflowTemplate — dispatch to the appropriate template handler.
 *
 * Called after a workflow_run is created. Routes the run to the template's
 * implementation (onboarding-emails, activation-nudge, etc.) which decides
 * whether to send immediately (autonomy=4), queue for approval (autonomy=3),
 * or draft-only (autonomy <= 2).
 */
export async function executeWorkflowTemplate(
  db: Db,
  workflow: Workflow,
  workflowRun: WorkflowRun,
): Promise<void> {
  switch (workflow.template) {
    case "onboarding-emails":
      await executeOnboardingEmailTemplate(db, workflow, workflowRun);
      break;
    case "upsell":
      await executeUpsellTemplate(db, workflow, workflowRun);
      break;
    // Future templates: activation-nudge, churn-rescue
    default:
      logger.warn(
        { template: workflow.template, workflowId: workflow.id },
        "unknown workflow template",
      );
  }
}

// ── Activate / pause helpers (convenience wrappers used by template code) ─────

export async function activateWorkflow(
  db: Db,
  companyId: string,
  workflowId: string,
  actorType: "agent" | "user" | "system",
  actorId: string,
): Promise<Workflow | null> {
  return updateWorkflow(db, {
    companyId,
    workflowId,
    actorType,
    actorId,
    patch: { status: WORKFLOW_STATUSES[1] }, // "active"
  });
}

export async function pauseWorkflow(
  db: Db,
  companyId: string,
  workflowId: string,
  actorType: "agent" | "user" | "system",
  actorId: string,
): Promise<Workflow | null> {
  return updateWorkflow(db, {
    companyId,
    workflowId,
    actorType,
    actorId,
    patch: { status: WORKFLOW_STATUSES[2] }, // "paused"
  });
}
