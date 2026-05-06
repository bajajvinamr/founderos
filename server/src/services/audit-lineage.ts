/**
 * Audit lineage (S6.3) — expand the `lineage_refs` jsonb column on a
 * single activity_log row into the full chain of upstream entities
 * that justified this action.
 *
 * Read shape:
 *   {
 *     log: ActivityLogRow,
 *     workflow: { id, name, template, status, autonomyLevel } | null,
 *     workflowRun: { id, status, triggeredBy, createdAt } | null,
 *     insights: Array<{ id, department, kind, title, confidence, status, createdAt }>,
 *     approvals: Array<{ id, type, status, decidedAt, decisionNote }>,
 *     events:    Array<{ id, source, eventName, occurredAt }>,
 *   }
 *
 * Tenant safety:
 *   Every expansion query is scoped to the activity log row's companyId.
 *   The lineage_refs column is jsonb and could be tampered with at write
 *   time — never trust the IDs without a tenant filter. This is the
 *   defense-in-depth for cross-org leak (vinamr-invariants pattern).
 *
 * Empty handling:
 *   If lineage_refs is null OR an array key is missing OR the referenced
 *   IDs no longer exist, the corresponding result array is empty (NOT
 *   throws). The UI renders "no lineage captured" cleanly. A pre-S6 row
 *   with no lineage_refs returns just { log, workflow?, workflowRun? }
 *   filled in via the existing workflowId column.
 *
 * The workflow + workflowRun fields are derived independently via
 *   activity_log.workflow_id and activity_log.run_id  (NOT through
 *   lineage_refs) because both columns existed before lineage_refs.
 */

import { eq, inArray, and, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  activityLog,
  approvals,
  events,
  insights,
  workflowRuns,
  workflows,
} from "@founderos/db";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LineageExpansion {
  log: typeof activityLog.$inferSelect;
  workflow: {
    id: string;
    name: string;
    template: string;
    status: string;
    autonomyLevel: number;
  } | null;
  workflowRun: {
    id: string;
    status: string;
    triggeredBy: unknown;
    createdAt: Date;
  } | null;
  insights: Array<{
    id: string;
    department: string;
    kind: string;
    title: string;
    confidence: number;
    status: string;
    createdAt: Date;
  }>;
  approvals: Array<{
    id: string;
    type: string;
    status: string;
    decidedAt: Date | null;
    decisionNote: string | null;
  }>;
  events: Array<{
    id: string;
    source: string;
    eventName: string;
    occurredAt: Date;
  }>;
}

export async function expandAuditLineage(
  db: Db,
  logId: string,
): Promise<LineageExpansion | null> {
  const [log] = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.id, logId))
    .limit(1);

  if (!log) return null;

  const refs = log.lineageRefs ?? {};
  const insightIds = Array.isArray(refs.insightIds) ? refs.insightIds : [];
  const approvalIds = Array.isArray(refs.approvalIds) ? refs.approvalIds : [];
  const eventIds = Array.isArray(refs.eventIds) ? refs.eventIds : [];

  // Workflow + workflow_run derived from columns, not refs.
  // These are the simplest case — direct lookups by single ID.
  const workflowRow = log.workflowId
    ? await fetchWorkflow(db, log.companyId, log.workflowId)
    : null;

  // log.runId → heartbeatRuns; we want workflow_runs which is different.
  // The workflow_run linkage actually lives in activity_log.workflow_id +
  // a separate query. v1 doesn't track workflow_run_id on activity_log
  // directly (S6.2's column lives on approvals); for now we leave
  // workflowRun null unless we can derive it from a referenced approval.
  const workflowRun: LineageExpansion["workflowRun"] = null;

  // Insights expansion — re-check companyId for tenant safety.
  const insightRows =
    insightIds.length > 0
      ? await db
          .select({
            id: insights.id,
            department: insights.department,
            kind: insights.kind,
            title: insights.title,
            confidence: insights.confidence,
            status: insights.status,
            createdAt: insights.createdAt,
          })
          .from(insights)
          .where(
            and(
              inArray(insights.id, insightIds),
              eq(insights.companyId, log.companyId),
            ),
          )
      : [];

  // Approvals expansion — same tenant scope.
  const approvalRows =
    approvalIds.length > 0
      ? await db
          .select({
            id: approvals.id,
            type: approvals.type,
            status: approvals.status,
            decidedAt: approvals.decidedAt,
            decisionNote: approvals.decisionNote,
          })
          .from(approvals)
          .where(
            and(
              inArray(approvals.id, approvalIds),
              eq(approvals.companyId, log.companyId),
            ),
          )
      : [];

  // Events expansion — same tenant scope.
  const eventRows =
    eventIds.length > 0
      ? await db
          .select({
            id: events.id,
            source: events.source,
            eventName: events.eventName,
            occurredAt: events.occurredAt,
          })
          .from(events)
          .where(
            and(
              inArray(events.id, eventIds),
              eq(events.companyId, log.companyId),
            ),
          )
      : [];

  return {
    log,
    workflow: workflowRow,
    workflowRun,
    insights: insightRows,
    approvals: approvalRows,
    events: eventRows,
  };
}

async function fetchWorkflow(
  db: Db,
  companyId: string,
  workflowId: string,
): Promise<LineageExpansion["workflow"]> {
  // S1.8 stored activity_log.workflow_id as TEXT (workflows table didn't
  // exist yet). The column now holds the workflow uuid as a string, but
  // workflows.id is UUID — postgres doesn't auto-cast text=uuid, so a
  // direct `eq()` compares incompatible types. Cast the parameter side
  // explicitly. Defense: skip the lookup entirely if the string isn't a
  // valid uuid shape — protects against a `::uuid` cast error from
  // legacy/garbage values.
  if (!UUID_REGEX.test(workflowId)) return null;
  const [row] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      template: workflows.template,
      status: workflows.status,
      autonomyLevel: workflows.autonomyLevel,
    })
    .from(workflows)
    .where(
      and(
        sql`${workflows.id} = ${workflowId}::uuid`,
        eq(workflows.companyId, companyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Marker — silence TS unused warning for workflowRuns import. Kept for
// the v1.1 path where activity_log.workflow_run_id lands as an FK and
// we expand the run row directly here.
void workflowRuns;
