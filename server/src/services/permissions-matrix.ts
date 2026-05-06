/**
 * Permissions matrix (S6.1) — single read-side aggregator over the existing
 * autonomy primitives.
 *
 * Sources:
 *   - workspace_departments.autonomyLevel (1..4) — the dept-level default
 *   - workflows.autonomyLevel (1..4)              — per-workflow override
 *   - instance_settings → lifecycle_crm.allow_autonomous_email — the
 *     master switch that gates EFFECTIVE autonomy=4 regardless of the
 *     per-workflow setting (canRunAutonomously() truth table)
 *
 * Output:
 *   {
 *     companyId,
 *     autonomousMasterSwitch: boolean,  // instance-wide opt-in for level=4
 *     departments: [{
 *       id, label, icon, deptAutonomy,
 *       workflows: [{ id, name, template, status, autonomy, source }]
 *     }]
 *   }
 *
 * `source` is "override" when the workflow has its own autonomy distinct
 * from the dept default; "inherited" otherwise. The UI uses this to know
 * whether resetting the cell falls back to the dept value or wipes a
 * dedicated override.
 *
 * NOTE: workflow-to-department mapping is derived from `workflow.template`
 * matching a department. We don't store an explicit `departmentId` on
 * workflows yet — that's a v1.1 schema change. Until then, the mapping
 * uses the WORKFLOW_DEPARTMENT_MAP table below. A workflow whose template
 * doesn't appear in the map is grouped under the special "_uncategorized"
 * key, which the UI hides until v1.1 lands the explicit FK.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  AUTONOMY_LEVELS,
  departments,
  instanceSettings,
  workflows,
  workspaceDepartments,
} from "@founderos/db";
import { AUTONOMOUS_EMAIL_SETTING_KEY } from "./workflow-autonomy.js";

/**
 * Template → department mapping. Until workflows.departmentId lands as an
 * FK column, this is the single authoritative place that maps a workflow
 * template to its owning department in the matrix view.
 *
 * Keys MUST be values present in WORKFLOW_TEMPLATES (and the matching
 * `workflows_template_check` DB CHECK constraint). When new templates
 * land in the registry, add them to:
 *   1. packages/db/src/schema/workflows.ts → WORKFLOW_TEMPLATES
 *   2. The CHECK constraint via a new migration
 *   3. This map (so the UI knows which dept column to render them under)
 *
 * Templates not in this map fall through to "_uncategorized" — they
 * still appear in the workflow list, but the matrix groups them under a
 * special bucket that the UI hides until v1.1 adds workflows.departmentId.
 */
const WORKFLOW_DEPARTMENT_MAP: Record<string, string> = {
  // Lifecycle CRM (S4.x) — all four templates are CRM-owned today.
  "onboarding-emails": "crm",
  "activation-nudge": "crm",
  "churn-rescue": "crm",
  upsell: "crm",
  // Future additions (S6.5 named templates):
  //   "growth-anomaly":  "growth",
  //   "content-loop":    "content",
  //   "revenue-rescue":  "finance",
};

export type AutonomySource = "inherited" | "override";

export interface PermissionsMatrixWorkflow {
  id: string;
  name: string;
  template: string;
  status: string;
  autonomy: number;
  source: AutonomySource;
}

export interface PermissionsMatrixDepartment {
  id: string;
  label: string;
  icon: string | null;
  deptAutonomy: number;
  workflows: PermissionsMatrixWorkflow[];
}

export interface PermissionsMatrix {
  companyId: string;
  autonomousMasterSwitch: boolean;
  departments: PermissionsMatrixDepartment[];
}

export async function computePermissionsMatrix(
  db: Db,
  companyId: string,
): Promise<PermissionsMatrix> {
  // 1. Read instance master switch (raw JSONB; matches workflow-autonomy.ts).
  const [settingsRow] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const general = (settingsRow?.general ?? {}) as Record<string, unknown>;
  const autonomousMasterSwitch = general[AUTONOMOUS_EMAIL_SETTING_KEY] === true;

  // 2. Read department catalogue (every dept exists, even if not enabled).
  const allDepartments = await db
    .select({
      id: departments.id,
      label: departments.label,
      icon: departments.icon,
      sortOrder: departments.sortOrder,
    })
    .from(departments)
    .orderBy(departments.sortOrder);

  // 3. Read per-company dept autonomy (may not have a row → fall back to default).
  const wsRows = await db
    .select({
      departmentId: workspaceDepartments.departmentId,
      autonomyLevel: workspaceDepartments.autonomyLevel,
    })
    .from(workspaceDepartments)
    .where(eq(workspaceDepartments.companyId, companyId));
  const deptAutonomyByDeptId = new Map<string, number>();
  for (const r of wsRows) {
    deptAutonomyByDeptId.set(r.departmentId, r.autonomyLevel);
  }

  // 4. Read all workflows for this company (cheap; v1 workspaces have <50).
  const wfRows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      template: workflows.template,
      status: workflows.status,
      autonomyLevel: workflows.autonomyLevel,
    })
    .from(workflows)
    .where(eq(workflows.companyId, companyId));

  // 5. Group workflows by department via the template map.
  const byDept = new Map<string, PermissionsMatrixWorkflow[]>();
  for (const wf of wfRows) {
    const deptId = WORKFLOW_DEPARTMENT_MAP[wf.template] ?? "_uncategorized";
    const deptDefault = deptAutonomyByDeptId.get(deptId) ?? AUTONOMY_LEVELS.DRAFT;
    const source: AutonomySource =
      wf.autonomyLevel === deptDefault ? "inherited" : "override";

    if (!byDept.has(deptId)) byDept.set(deptId, []);
    byDept.get(deptId)!.push({
      id: wf.id,
      name: wf.name,
      template: wf.template,
      status: wf.status,
      autonomy: wf.autonomyLevel,
      source,
    });
  }

  // 6. Compose final matrix — every catalogued dept appears, even with zero
  //    workflows, so the UI always renders the full department column.
  const result: PermissionsMatrixDepartment[] = allDepartments.map((d) => ({
    id: d.id,
    label: d.label,
    icon: d.icon,
    deptAutonomy: deptAutonomyByDeptId.get(d.id) ?? AUTONOMY_LEVELS.DRAFT,
    workflows: byDept.get(d.id) ?? [],
  }));

  return {
    companyId,
    autonomousMasterSwitch,
    departments: result,
  };
}
