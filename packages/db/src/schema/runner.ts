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

import { sql } from "drizzle-orm";
import type { AgentAdapterType } from "@founderos/shared";
import {
  check,
  foreignKey,
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
    /**
     * W0.3 (council 2026-05-05) — TTL for the token. NULL = indefinite
     * (legacy rows pre-migration 0089). New issuance defaults to 90 days.
     * Auth middleware rejects rows where expires_at < now() with a
     * "rotation hint" payload so the runner can prompt the user to
     * re-mint via the rotation endpoint instead of failing silently.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * W0.3 — chain of rotations. When an operator rotates a token (lost
     * laptop, near-expiry refresh), the new token's row points back to
     * the old one via this column. Lets us reconstruct "every token that
     * descended from compromised token X" with a single recursive CTE.
     */
    rotatedFromTokenId: uuid("rotated_from_token_id"),
    /**
     * W0.3 — opaque device fingerprint string captured by the runner at
     * install time (hostname + OS + first-boot UUID, sha256-hashed
     * client-side). NOT a security boundary — it's an audit signal so
     * support can spot when a single token starts hitting from two
     * device fingerprints (= leaked credentials).
     */
    deviceFingerprint: text("device_fingerprint"),
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
    // W0.3 — partial index on non-null expires_at; supports the
    // dashboard "tokens nearing expiry" + the middleware fast-path.
    expiresAtIdx: index("runner_tokens_expires_at_idx").on(table.expiresAt),
    // W0.3 — rotation-chain audit query.
    rotatedFromIdx: index("runner_tokens_rotated_from_idx").on(table.rotatedFromTokenId),
    // Self-FK for rotation chain (added explicitly so drizzle generates
    // the `runner_tokens_rotated_from_token_id_fk` constraint matching
    // the migration SQL).
    rotatedFromFk: foreignKey({
      columns: [table.rotatedFromTokenId],
      foreignColumns: [table.id],
      name: "runner_tokens_rotated_from_token_id_fk",
    }).onDelete("set null"),
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
    /**
     * Same-tenant invariant enforced by the composite FK
     * `runner_jobs_agent_id_company_id_agents_id_company_id_fk` —
     * see migration 0085_tenant_invariants.sql.
     */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * The heartbeat_runs row this job materializes. Created in the same
     * transaction as the job. byo_runner.execute() reads this back to
     * finalize the heartbeat_run record on completion.
     *
     * Same-tenant invariant enforced by the composite FK
     * `runner_jobs_heartbeat_run_id_company_id_heartbeat_runs_id_company_id_fk`
     * — see migration 0085_tenant_invariants.sql.
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

    /**
     * S7.0.1 — Adapter type the runner should dispatch on. Mirrors
     * `agents.adapter_type` and `AGENT_ADAPTER_TYPES` in
     * `packages/shared/src/constants.ts`. CHECK constraint enforced at the
     * DB layer per migration 0105 — adding a new value here MUST come with
     * a follow-up migration that extends the CHECK list.
     *
     * Default `claude_local` preserves existing prod behavior (claude was
     * the only spawned binary pre-S7). Pre-S7 enqueue path wrote
     * `byo_runner` — those rows continue to work via legacy-fallback in
     * the dispatcher.
     */
    adapterType: text("adapter_type")
      .$type<AgentAdapterType>()
      .notNull()
      .default("claude_local"),

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
    // S7.0.1 — operational query: "show me queued jobs by adapter type"
    // (multi-CLI runner pool will need this post-S7).
    adapterTypeIdx: index("runner_jobs_adapter_type_idx").on(table.adapterType),
    // Reverse lookup: heartbeat_runs → runner_jobs (rare but useful for audit UI).
    heartbeatRunIdx: index("runner_jobs_heartbeat_run_idx").on(table.heartbeatRunId),
    // Same-tenant invariant (composite FK) — migration 0085.
    agentTenantFk: foreignKey({
      name: "runner_jobs_agent_id_company_id_agents_id_company_id_fk",
      columns: [table.agentId, table.companyId],
      foreignColumns: [agents.id, agents.companyId],
    }).onDelete("cascade"),
    heartbeatRunTenantFk: foreignKey({
      name: "runner_jobs_heartbeat_run_id_company_id_heartbeat_runs_id_company_id_fk",
      columns: [table.heartbeatRunId, table.companyId],
      foreignColumns: [heartbeatRuns.id, heartbeatRuns.companyId],
    }).onDelete("cascade"),
    // Status enum CHECK — migration 0085. Mirrors RunnerJobStatus.
    statusCheck: check(
      "runner_jobs_status_check",
      sql`${table.status} IN ('queued','claimed','streaming','completed','failed','cancelled')`,
    ),
  }),
);
