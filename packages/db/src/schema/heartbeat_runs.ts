import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, foreignKey, pgTable, uuid, text, timestamp, jsonb, index, integer, bigint, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `heartbeat_runs_agent_id_company_id_agents_id_company_id_fk` —
     * see migration 0085_tenant_invariants.sql.
     */
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    /**
     * Same-tenant invariant enforced by the composite FK
     * `heartbeat_runs_wakeup_request_id_company_id_agent_wakeup_requests_id_company_id_fk` —
     * see migration 0085_tenant_invariants.sql.
     */
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    processPid: integer("process_pid"),
    processGroupId: integer("process_group_id"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    issueCommentStatus: text("issue_comment_status").notNull().default("not_applicable"),
    issueCommentSatisfiedByCommentId: uuid("issue_comment_satisfied_by_comment_id"),
    issueCommentRetryQueuedAt: timestamp("issue_comment_retry_queued_at", { withTimezone: true }),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    // Same-tenant invariants (composite FKs) — migration 0085.
    agentTenantFk: foreignKey({
      name: "heartbeat_runs_agent_id_company_id_agents_id_company_id_fk",
      columns: [table.agentId, table.companyId],
      foreignColumns: [agents.id, agents.companyId],
    }),
    wakeupRequestTenantFk: foreignKey({
      name: "heartbeat_runs_wakeup_request_id_company_id_agent_wakeup_requests_id_company_id_fk",
      columns: [table.wakeupRequestId, table.companyId],
      foreignColumns: [agentWakeupRequests.id, agentWakeupRequests.companyId],
    }),
    // Status enum CHECK — migration 0085. Mirrors HEARTBEAT_RUN_STATUSES
    // plus 'coalesced' (heartbeat scheduler-only synthetic state).
    statusCheck: check(
      "heartbeat_runs_status_check",
      sql`${table.status} IN ('queued','running','succeeded','failed','cancelled','timed_out','coalesced')`,
    ),
  }),
);
