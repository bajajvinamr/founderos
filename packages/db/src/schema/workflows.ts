/**
 * workflows — Lifecycle CRM workflow registry (S4.5)
 *
 * Workflows are templated, parameterisable automations that the CRM agent
 * uses to drive retention, activation, and upsell loops. This schema is the
 * canonical source of truth queried by S4.6–S4.9 template implementations.
 *
 * ## Tenant isolation
 *   workflows carries a composite UNIQUE on (id, company_id) so child tables
 *   (workflow_runs) can reference both columns via a composite FK — the same
 *   pattern used in 0085_tenant_invariants.sql. The composite FK is added in
 *   the migration (0087) after the parent UNIQUE exists.
 *
 * ## Enum columns (text + DB CHECK)
 *   All status/kind/template text columns use text storage with:
 *   (a) TS `$type<>()` for compile-time narrowing, and
 *   (b) DB-level CHECK constraints in the migration as the runtime backstop.
 *   TS union types erase at compile time; CHECK catches raw-SQL bypasses,
 *   agent hand-crafted inserts, and future migration writers who add values
 *   without updating the union.
 *
 * ## Autonomy gate
 *   autonomyLevel is an integer 1–4 (see AUTONOMY_LEVELS below).
 *   CRITICALLY: it defaults to 2 (draft-only) at the DB layer, NOT 4
 *   (autonomous). Any workflow that mutates customer-facing state (email,
 *   Slack, charge) requires explicit per-instance opt-in stored in
 *   instance_settings — a workflow-level autonomyLevel=4 is a NECESSARY but
 *   NOT sufficient condition. canRunAutonomously() in the service layer
 *   enforces both checks.
 *
 * ## Audit log
 *   Every workflow state transition (create, status change, autonomy change)
 *   MUST emit an activity_log row via logActivity(). The route layer is
 *   responsible for calling logActivity after each mutating operation; the
 *   schema does not auto-audit (no triggers) so the call sites are explicit
 *   and reviewable.
 *
 * ## workflow_runs tenant isolation
 *   workflow_runs.company_id is denormalised from workflows.company_id to
 *   allow the composite FK enforcement pattern. It is NOT nullable — the
 *   route layer writes it alongside workflowId on every insert.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// ── Constant arrays (used for Zod enums in the route layer) ──────────────────

export const WORKFLOW_TEMPLATES = [
  "onboarding-emails",
  "activation-nudge",
  "churn-rescue",
  "upsell",
] as const;

export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];

export const WORKFLOW_TRIGGER_KINDS = [
  "event",
  "schedule",
  "manual",
] as const;

export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

export const WORKFLOW_STATUSES = [
  "draft",
  "active",
  "paused",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * Autonomy levels govern how much the agent can execute without human approval.
 *
 *   1 = observe   — agent analyses; never acts
 *   2 = draft     — agent drafts actions (emails, notes); founder reviews before
 *                   anything is sent (DEFAULT — least privilege)
 *   3 = approval  — agent queues actions; a human must explicitly approve each
 *                   run via the approvals table before execution
 *   4 = autonomous — agent executes immediately; NO human in the loop
 *                   (requires BOTH workflow.autonomyLevel=4 AND the instance-
 *                   level `lifecycle_crm.allow_autonomous_email` flag in
 *                   instance_settings to be true)
 *
 * The DB default is 2 (draft). autonomyLevel=4 is NEVER set by default on any
 * seeded or templated workflow — it requires explicit founder opt-in.
 */
export const AUTONOMY_LEVELS = {
  OBSERVE: 1,
  DRAFT: 2,
  APPROVAL_REQUIRED: 3,
  AUTONOMOUS: 4,
} as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[keyof typeof AUTONOMY_LEVELS];

export const WORKFLOW_RUN_STATUSES = [
  "pending_approval",
  "running",
  // S4.8 prereq #194: "approved" is a transient state between
  // pending_approval and dispatch — used by the workflow-run-approval
  // service to mark "human said yes; dispatcher should re-execute now".
  // The dispatcher then transitions approved → completed | failed.
  "approved",
  // "rejected" is terminal — human declined, no further action.
  "rejected",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// ── Trigger spec shapes ───────────────────────────────────────────────────────

export type WorkflowTriggerSpec =
  | { source: string; event: string; filters?: Record<string, unknown> }
  | { cron: string; timezone?: string }
  | { description?: string };

// ── workflow_runs actions array entry ─────────────────────────────────────────

export type WorkflowAction = {
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "completed" | "failed" | "skipped";
  executedAt?: string | null;
  error?: string | null;
};

// ── Tables ────────────────────────────────────────────────────────────────────

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * template identifies which template implementation handles this workflow.
     * DB CHECK constraint (in migration) enforces the closed set.
     * New templates MUST be added to WORKFLOW_TEMPLATES + CHECK simultaneously.
     */
    template: text("template").$type<WorkflowTemplate>().notNull(),
    triggerKind: text("trigger_kind").$type<WorkflowTriggerKind>().notNull(),
    triggerSpec: jsonb("trigger_spec").$type<WorkflowTriggerSpec>().notNull(),
    /**
     * autonomyLevel: 1=observe, 2=draft (DEFAULT), 3=approval-required,
     * 4=autonomous. DB default is 2 (least privilege). Routes MUST NOT
     * accept autonomyLevel=4 without verifying the instance-level opt-in flag.
     * See canRunAutonomously() in the service layer.
     */
    autonomyLevel: integer("autonomy_level").notNull().default(AUTONOMY_LEVELS.DRAFT),
    status: text("status").$type<WorkflowStatus>().notNull().default("draft"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Composite unique — enables composite FK in workflow_runs. */
    idCompanyUq: uniqueIndex("workflows_id_company_id_uq").on(t.id, t.companyId),
    byCompanyStatus: index("workflows_company_status_idx").on(t.companyId, t.status),
    byTemplate: index("workflows_company_template_idx").on(t.companyId, t.template),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    /**
     * companyId is denormalised from workflows.company_id. Required to enforce
     * the composite FK into workflows(id, company_id), preventing cross-tenant
     * row injection where an attacker supplies a workflowId from another company.
     * The route layer MUST always write companyId = req.actor.companyId (or the
     * path-param companyId, which assertCompanyAccess has already validated).
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").$type<WorkflowRunStatus>().notNull().default("running"),
    /**
     * triggeredBy: who/what started this run.
     *   { kind: "event",    eventId: string, eventName: string }
     *   { kind: "schedule", cron: string }
     *   { kind: "manual",   actorId: string }
     */
    triggeredBy: jsonb("triggered_by")
      .$type<{ kind: "event" | "schedule" | "manual"; [key: string]: unknown }>()
      .notNull(),
    /** Array of WorkflowAction entries — written incrementally as run progresses. */
    actions: jsonb("actions").$type<WorkflowAction[]>().notNull().default([]),
    /** KPI snapshot at run start — used for lift measurement 7d later. */
    metricSnapshot: jsonb("metric_snapshot").$type<Record<string, unknown>>(),
    /**
     * idempotencyKey: optional composite-scoped dedup key for workflow run creation.
     * When provided, enables race-safe dedup via UNIQUE NULLS NOT DISTINCT on
     * (company_id, workflow_id, idempotency_key). Null values collide once per
     * (company_id, workflow_id) pair, preventing accidental dual-NULL rows during
     * migration. Used to prevent duplicate runs from dual triggers (kpi_anomaly
     * insight + Stripe at_risk webhook on same customer same day).
     */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkflow: index("workflow_runs_workflow_id_idx").on(t.workflowId),
    byCompanyStatus: index("workflow_runs_company_status_idx").on(t.companyId, t.status),
    byCompanyCreated: index("workflow_runs_company_created_idx").on(t.companyId, t.createdAt.desc()),
  }),
);

// ── Inferred types ────────────────────────────────────────────────────────────

export type Workflow = typeof workflows.$inferSelect;
export type WorkflowInsert = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowRunInsert = typeof workflowRuns.$inferInsert;
