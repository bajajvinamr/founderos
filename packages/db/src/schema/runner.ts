/**
 * BYO Runner — ADR-011 (2026-05-04).
 *
 * Two tables:
 *
 * 1. `runner_tokens` — long-lived bearer tokens scoped to a single company.
 *    Plaintext is shown once at issuance; only sha256 hash is persisted.
 *    Constant-time compare on lookup. Revoke flips `revokedAt`.
 *
 * 2. `runner_jobs` — queue entries the local runner polls. The byo_runner
 *    adapter materializes a row here when an agent's heartbeat is scheduled;
 *    the runner claims atomically (UPDATE … WHERE status='queued'), spawns
 *    `claude` locally, streams events back, and POSTs completion. The row
 *    is the FK anchor between heartbeat_runs (cloud's canonical run record)
 *    and the runner-driven execution.
 *
 * The runner-side audit trail (claim, events, complete) is logged via the
 * existing `heartbeat_run_events` table on heartbeat_run_id. We do NOT
 * duplicate the event store.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /**
     * sha256 hex of the plaintext token. NEVER stores plaintext. Lookup
     * uses crypto.timingSafeEqual on this column to avoid timing oracle.
     */
    tokenHash: text("token_hash").notNull(),
    /** Human-readable label shown in the dashboard. e.g. "Vinamr's MacBook" */
    label: text("label").notNull().default(""),
    /**
     * UserId that minted this token. Audit trail anchor — cross-references
     * activity_log entry where action='runner.token.issued'.
     * `text` (not uuid) because Better Auth stores user.id as text.
     */
    createdByUserId: text("created_by_user_id").references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Touched on every successful auth-middleware lookup. Drives the
     * dashboard liveness indicator (online if within 30s).
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /**
     * NULL while active; flipped by DELETE /companies/:id/runner-tokens/:id.
     * Auth middleware refuses tokens with non-null revokedAt.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // Hash uniqueness — collision is sha256-improbable but the constraint
    // keeps the DB honest and lets the issuance code use ON CONFLICT
    // semantics if we ever rotate-in-place (currently revoke + reissue).
    tokenHashUnique: uniqueIndex("runner_tokens_token_hash_unique").on(table.tokenHash),
    // Dashboard query: list active tokens for a company.
    companyActiveIdx: index("runner_tokens_company_active_idx").on(
      table.companyId,
      table.revokedAt,
    ),
  }),
);

export type RunnerJobStatus =
  | "queued"
  | "claimed"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export const runnerJobs = pgTable(
  "runner_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * The heartbeat_runs row this job materializes. Created in the same
     * transaction as the job. byo_runner.execute() reads this back to
     * finalize the heartbeat_run record on completion.
     */
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),

    /**
     * Materialized prompt the runner passes via stdin to `claude --print -`.
     * Built by the cloud adapter from the agent's prompt template + bootstrap
     * + wake context — same machinery as claude_local.
     */
    prompt: text("prompt").notNull(),
    /** sha256 of `prompt` — runner echoes back in events for tamper detection. */
    promptHash: text("prompt_hash").notNull(),
    /** Optional --resume target. Null on first run for an agent. */
    sessionIdHint: text("session_id_hint"),
    /**
     * Runtime config the runner uses to build CLI args. Mirrors the shape
     * of buildClaudeArgs() in claude-local: { model, maxTurns, timeoutSec,
     * instructionsFileContent (base64), addDirs }.
     */
    runtimeConfig: text("runtime_config").notNull(), // JSON-encoded; not jsonb to avoid Drizzle inference cost on hot path

    status: text("status").notNull().default("queued").$type<RunnerJobStatus>(),

    // Claim machinery
    claimedByTokenId: uuid("claimed_by_token_id").references(() => runnerTokens.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    // Completion
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    elapsedMs: bigint("elapsed_ms", { mode: "number" }),
    /** Cost in micro-USD (1e-6 USD), parsed from claude stream-json result.cost. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    /** Output session id from claude — runner reports for next heartbeat's --resume. */
    sessionIdAfter: text("session_id_after"),
    /** claude --version captured at runner startup, surfaced in dashboard. */
    cliVersion: text("cli_version"),
    /** Surfaced to UI on status=failed. */
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Hot path: GET /api/runner/jobs/next — pulls oldest queued for a token's
    // company, ordered by createdAt. Index supports the WHERE + ORDER BY.
    companyStatusCreatedIdx: index("runner_jobs_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    // Dashboard: per-token job history.
    claimedByIdx: index("runner_jobs_claimed_by_idx").on(table.claimedByTokenId),
    // Reverse lookup: heartbeat_runs → runner_jobs (rare but useful for audit UI).
    heartbeatRunIdx: index("runner_jobs_heartbeat_run_idx").on(table.heartbeatRunId),
  }),
);
