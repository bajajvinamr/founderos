/**
 * Template registry (S6.5) — metadata catalogue for the named workflow
 * templates the PRD calls out (Growth Anomaly, Content Loop, Revenue
 * Rescue). The registry surfaces what's *available* for a workspace to
 * adopt and where each template lives in the dept hierarchy.
 *
 * This file is intentionally pure-data (no DB reads, no side effects).
 * The UI uses it to render a template gallery; the `instantiate` field
 * points at the workflow.template enum value to use when materializing
 * a workflow row from the chosen template.
 *
 * Why a registry separate from WORKFLOW_TEMPLATES enum:
 *   - WORKFLOW_TEMPLATES (in @founderos/db) is the runtime/CHECK enum —
 *     every value must have an executor and live under the SQL CHECK
 *     constraint. New executors require schema migrations.
 *   - The named PRD flagships are PRESENTATION-LAYER groupings. Some
 *     map 1:1 to enum values today (revenue-rescue → churn-rescue).
 *     Others are defined here as v1.1-pending (growth-anomaly,
 *     content-loop) — the UI shows them as "Coming soon" until the
 *     executor + CHECK migration land.
 *
 * Status legend:
 *   - "live"        → enum value exists, executor wired, can be created
 *   - "v1.1_planned" → metadata only; NEW workflow rows of this template
 *                      cannot be created yet (route layer rejects)
 */

export type NamedTemplateStatus = "live" | "v1_1_planned";

export interface NamedTemplate {
  id: string; // stable slug for the UI to bind to
  displayName: string;
  department: string; // matches workspace_departments.id
  status: NamedTemplateStatus;
  /**
   * The runtime enum value this template instantiates as. Null when the
   * template is in v1.1_planned state — the registry advertises the
   * intent but no executor exists yet.
   */
  instantiateAs: string | null;
  triggerSummary: string;
  outcomeSummary: string;
  defaultAutonomy: 1 | 2 | 3 | 4;
}

export const NAMED_TEMPLATES: NamedTemplate[] = [
  {
    id: "growth-anomaly",
    displayName: "Growth Anomaly Diagnostic",
    department: "growth",
    status: "v1_1_planned",
    instantiateAs: null,
    triggerSummary:
      "kpi_anomaly insight on signup CVR with severity ≥ warning",
    outcomeSummary:
      "Funnel diagnostic → 2-3 fix hypotheses → experiment cards (proposed status). Founder picks which to run.",
    defaultAutonomy: 2,
  },
  {
    id: "content-loop",
    displayName: "Content Loop",
    department: "content",
    status: "v1_1_planned",
    instantiateAs: null,
    triggerSummary:
      "LinkedIn post performance > 90th percentile of workspace history",
    outcomeSummary:
      "Multi-format generation (thread, newsletter, landing copy, retargeting ad) → calendar schedule with 2-4 day spacing → founder approves the calendar.",
    defaultAutonomy: 3,
  },
  {
    id: "revenue-rescue",
    displayName: "Revenue Rescue",
    department: "finance",
    status: "live",
    instantiateAs: "churn-rescue",
    triggerSummary:
      "Stripe customer.subscription.deleted OR scheduled churn-risk scan",
    outcomeSummary:
      "Per-recipient send_email with coupon-redemption URL. Suppression-filtered, capped at 50/day, CAN-SPAM wrapped, generation frozen at create-time.",
    defaultAutonomy: 3,
  },
];

export interface NamedTemplateRegistryView {
  templates: NamedTemplate[];
  liveCount: number;
  plannedCount: number;
}

export function getTemplateRegistry(): NamedTemplateRegistryView {
  const live = NAMED_TEMPLATES.filter((t) => t.status === "live").length;
  const planned = NAMED_TEMPLATES.length - live;
  return {
    templates: NAMED_TEMPLATES,
    liveCount: live,
    plannedCount: planned,
  };
}

export function findNamedTemplate(id: string): NamedTemplate | null {
  return NAMED_TEMPLATES.find((t) => t.id === id) ?? null;
}
