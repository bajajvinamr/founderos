/**
 * BYO-104 — Runner REST endpoints (ADR-011, OpenAPI: docs/api/runner-openapi.yaml).
 *
 * Two route surfaces, two auth schemes:
 *
 * 1. **Runner-token auth** (mounted at `/api/runner` in app.ts behind
 *    `runnerAuthMiddleware`):
 *      GET  /jobs/next             — long-poll for next claimable job (≤30s)
 *      POST /jobs/:id/claim        — atomic claim
 *      POST /jobs/:id/events       — append event batch (idempotent on eventId)
 *      POST /jobs/:id/complete     — terminal state transition
 *
 * 2. **Session auth** (mounted inside the existing `api` Router):
 *      POST   /companies/:companyId/runner-tokens          — issue
 *      DELETE /companies/:companyId/runner-tokens/:tokenId — revoke
 *      GET    /companies/:companyId/runner-status          — liveness
 *
 * Every JSON error response includes `requestId` via the global error handler
 * (server/src/middleware/error-handler.ts:39 `withRequestId`). Per CLAUDE.md,
 * runner-originated incidents are triaged by quoting the request id back from
 * server logs / Sentry.
 */

import { Router, type Request, type RequestHandler } from "express";
import { randomBytes, createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import {
  agents,
  companyMemberships,
  companies,
  heartbeatRunEvents,
  runnerJobs,
  runnerTokens,
  type RunnerJobStatus,
} from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { LOCAL_BOARD_USER_ID } from "../auth/post-signup-hook.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Long-poll cap. Matches OpenAPI `204 No Content; runner should re-poll`. */
const NEXT_JOB_LONG_POLL_MS = 30_000;
/** Tight tick inside the long-poll. 1 s keeps DB load proportional to runners online. */
const NEXT_JOB_TICK_MS = 1_000;
/** Plaintext token: `fos_` + 32 alphanumeric chars (matches runner-auth TOKEN_FORMAT). */
const TOKEN_RANDOM_BYTES = 24; // base64url → 32 chars
/** Online window for `RunnerStatus.online`. Matches the 30 s debounce in runner-auth. */
const RUNNER_ONLINE_WINDOW_MS = 30_000;
/**
 * W0.3 (council 2026-05-05) — default TTL on token issuance. 90 days bounds
 * the blast radius of a leaked plaintext while staying well clear of the
 * "rotate every release" overhead. Operators can override via `expiresInDays`
 * in the issue body (1–365 inclusive); a literal `null` means indefinite
 * (legacy behavior, retained for embedded test fixtures + future opt-out).
 */
const RUNNER_TOKEN_DEFAULT_TTL_DAYS = 90;
const RUNNER_TOKEN_MAX_TTL_DAYS = 365;
const ONE_DAY_MS = 86_400_000;

function ttlDaysToExpiresAt(days: number | null | undefined): Date | null {
  if (days === null) return null;
  const resolved = days ?? RUNNER_TOKEN_DEFAULT_TTL_DAYS;
  return new Date(Date.now() + resolved * ONE_DAY_MS);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Hex(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generate a `fos_<32-char>` token. Uses 24 random bytes → base64url, then
 * substring to 32 chars. base64url is alphanumeric + `-` + `_`; we strip the
 * non-alphanumerics so the format matches the auth-middleware regex
 * `^fos_[A-Za-z0-9]{32}$`.
 */
function generateRunnerToken(): string {
  // Generate enough entropy that after stripping `-`/`_` we still have ≥32 chars.
  // 32 raw bytes → 43 base64url chars → ~10% loss to `-`/`_` substitution → ≥32 alnum.
  const buf = randomBytes(TOKEN_RANDOM_BYTES * 2);
  const alnum = buf.toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return `fos_${alnum.slice(0, 32)}`;
}

async function assertCanManageRunnerTokens(db: Db, req: Request, companyId: string): Promise<void> {
  if (req.actor.type !== "board") throw unauthorized();
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  if (!req.actor.userId) throw forbidden("Company owner or instance admin required");

  const [ownerMembership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, req.actor.userId),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .limit(1);

  if (!ownerMembership) {
    throw forbidden("Company owner or instance admin required");
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Common 401 helper for runner-auth routes. The auth middleware itself emits
 * the same shape; we use this for downstream "no-actor" guards. The error
 * handler attaches requestId so the caller can quote it.
 */
function ensureRunner(req: Request): { tokenId: string; companyId: string } {
  if (req.actor.type !== "runner" || !req.actor.runnerTokenId || !req.actor.companyId) {
    throw unauthorized("invalid_runner_token");
  }
  return { tokenId: req.actor.runnerTokenId, companyId: req.actor.companyId };
}

// ─── Zod schemas (mirror docs/api/runner-openapi.yaml) ──────────────────────

const issueTokenBodySchema = z.object({
  label: z.string().max(64).optional(),
  /**
   * W0.3 — TTL override. `undefined` → 90-day default. `null` → indefinite
   * (matches the pre-W0.3 behavior; gated to instance-admin + audit-logged).
   * Number → exact days (1–365 inclusive).
   */
  expiresInDays: z
    .union([z.number().int().min(1).max(RUNNER_TOKEN_MAX_TTL_DAYS), z.null()])
    .optional(),
});

const rotateTokenBodySchema = z.object({
  /** Carry-over label for the new token. Defaults to old token's label. */
  label: z.string().max(64).optional(),
  expiresInDays: z
    .union([z.number().int().min(1).max(RUNNER_TOKEN_MAX_TTL_DAYS), z.null()])
    .optional(),
  /** Opaque device fingerprint reported by the runner CLI on rotate. */
  deviceFingerprint: z.string().max(128).optional(),
});

const completeBodySchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int(),
  signal: z.string().nullable().optional(),
  elapsedSec: z.number().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  sessionId: z.string().nullable().optional(),
  cliVersion: z.string().optional(),
  errorMessage: z.string().nullable().optional(),
});

/**
 * RunnerEvent — payload union mirrors OpenAPI. We persist the kind-specific
 * payload as a `payload` jsonb on heartbeat_run_events so the existing
 * aggregation infra keeps working. `eventId` is runner-supplied (idempotency)
 * but v0 server is best-effort: we don't dedup at write time.
 */
const eventSchema = z.object({
  eventId: z.string().uuid(),
  kind: z.enum([
    "stdout_line",
    "stderr_line",
    "claude_message",
    "claude_tool_use",
    "claude_tool_result",
    "claude_result",
  ]),
  ts: z.string().datetime({ offset: true }),
  payload: z.union([z.record(z.unknown()), z.string()]).optional(),
});

const eventBatchSchema = z.object({
  events: z.array(eventSchema).min(1).max(256),
});

// ─── Runner-token routes (auth: runnerAuthMiddleware) ────────────────────────

/**
 * Routes consumed by `@founderos/runner`. Mount in app.ts BEHIND
 * `runnerAuthMiddleware(db)`, which already populates `req.actor.type ==='runner'`.
 *
 *     app.use("/api/runner", runnerAuthMiddleware(db), runnerJobRoutes(db));
 */
export function runnerJobRoutes(db: Db): Router {
  const router = Router();

  /**
   * GET /jobs/next — long-poll. Holds connection up to 30 s, ticks every 1 s
   * looking for a queued row scoped to the runner's company. Returns 204 on
   * timeout. Does NOT claim — runner must POST /:id/claim, which is the race
   * arbiter (runner with lowest network latency wins).
   */
  router.get("/jobs/next", async (req, res) => {
    const { companyId } = ensureRunner(req);
    const deadline = Date.now() + NEXT_JOB_LONG_POLL_MS;

    while (Date.now() < deadline) {
      const [next] = await db
        .select({
          jobId: runnerJobs.id,
          agentId: runnerJobs.agentId,
          agentName: agents.name,
          createdAt: runnerJobs.createdAt,
        })
        .from(runnerJobs)
        .innerJoin(agents, eq(agents.id, runnerJobs.agentId))
        .where(and(eq(runnerJobs.companyId, companyId), eq(runnerJobs.status, "queued")))
        .orderBy(asc(runnerJobs.createdAt))
        .limit(1);

      if (next) {
        res.status(200).json({
          jobId: next.jobId,
          agentId: next.agentId,
          agentName: next.agentName,
          createdAt: next.createdAt.toISOString(),
        });
        return;
      }

      // If the client disconnected while we were waiting, abort the loop —
      // continuing to poll for an absent socket wastes a DB roundtrip per tick.
      if (req.socket.destroyed || res.writableEnded) return;
      await sleep(NEXT_JOB_TICK_MS);
    }

    res.status(204).end();
  });

  /**
   * POST /jobs/:id/claim — atomic claim. The UPDATE…WHERE status='queued'
   * is the only place state transitions queued→claimed; PostgreSQL row-level
   * locking guarantees one runner wins.
   *
   * Audit: writes `runner.job.claimed` to activity_log with the heartbeat_run
   * id (so the heartbeat run row gets the claim event in its activity stream).
   */
  router.post("/jobs/:id/claim", async (req, res) => {
    const jobId = req.params.id as string;
    const { tokenId, companyId } = ensureRunner(req);

    // First load the row (typed) so we can return the full payload after a
    // successful UPDATE. We re-check status inside the UPDATE for atomicity.
    const [existing] = await db
      .select({
        id: runnerJobs.id,
        companyId: runnerJobs.companyId,
        agentId: runnerJobs.agentId,
        prompt: runnerJobs.prompt,
        promptHash: runnerJobs.promptHash,
        sessionIdHint: runnerJobs.sessionIdHint,
        runtimeConfig: runnerJobs.runtimeConfig,
        status: runnerJobs.status,
        heartbeatRunId: runnerJobs.heartbeatRunId,
      })
      .from(runnerJobs)
      .where(eq(runnerJobs.id, jobId))
      .limit(1);

    if (!existing) throw notFound("job_not_found");
    if (existing.companyId !== companyId) {
      // Cross-company isolation. Same shape as 404 to avoid leaking job
      // existence to a runner from a different company.
      throw notFound("job_not_found");
    }

    const [claimed] = await db
      .update(runnerJobs)
      .set({
        status: "claimed",
        claimedByTokenId: tokenId,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.status, "queued")))
      .returning({ id: runnerJobs.id });

    if (!claimed) {
      // Race lost or already terminal.
      throw conflict("job_not_claimable", { currentStatus: existing.status });
    }

    let runtimeConfig: Record<string, unknown>;
    try {
      runtimeConfig = JSON.parse(existing.runtimeConfig);
    } catch (err) {
      logger.error(
        { err, jobId, requestId: req.requestId },
        "runner-claim: runtime_config JSON parse failed — corrupt row",
      );
      // Treat as not-found to the caller; the bad row is logged for ops.
      throw notFound("job_not_found");
    }

    const [agent] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, existing.agentId))
      .limit(1);

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: `runner:${tokenId}`,
      action: "runner.job.claimed",
      entityType: "runner_job",
      entityId: jobId,
      agentId: existing.agentId,
      runId: existing.heartbeatRunId,
      details: { tokenId },
    });

    res.status(200).json({
      jobId: existing.id,
      agentId: existing.agentId,
      agentName: agent?.name ?? "agent",
      prompt: existing.prompt,
      sessionId: existing.sessionIdHint,
      runtimeConfig,
      promptHash: existing.promptHash,
      // OpenAPI: `addDirs` is optional. v0 has no cloud-suggested add-dirs;
      // the runner derives them from runtimeConfig if present.
      addDirs: Array.isArray((runtimeConfig as { addDirs?: unknown }).addDirs)
        ? ((runtimeConfig as { addDirs: string[] }).addDirs)
        : [],
    });
  });

  /**
   * POST /jobs/:id/events — append event batch. Persists into the existing
   * `heartbeat_run_events` table (no new event store) on the heartbeat_run_id
   * the job materialized. Idempotency is the runner's responsibility for v0
   * (track sent eventIds locally, only retry on 5xx).
   *
   * Authorization gate: the job must be CLAIMED BY THIS TOKEN. Stops a
   * compromised token from another company spamming events into a job it
   * doesn't own. Same-company-different-token is also a 403 — claim ownership
   * is the gate, not company access.
   */
  router.post("/jobs/:id/events", validate(eventBatchSchema), async (req, res) => {
    const jobId = req.params.id as string;
    const { tokenId, companyId } = ensureRunner(req);

    const [job] = await db
      .select({
        id: runnerJobs.id,
        companyId: runnerJobs.companyId,
        agentId: runnerJobs.agentId,
        heartbeatRunId: runnerJobs.heartbeatRunId,
        status: runnerJobs.status,
        claimedByTokenId: runnerJobs.claimedByTokenId,
      })
      .from(runnerJobs)
      .where(eq(runnerJobs.id, jobId))
      .limit(1);

    if (!job || job.companyId !== companyId) throw notFound("job_not_found");
    if (job.claimedByTokenId !== tokenId) throw forbidden("job_not_owned_by_token");
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      throw conflict("job_terminal", { status: job.status });
    }

    // Flip queued/claimed → streaming on first event batch.
    if (job.status !== "streaming") {
      await db
        .update(runnerJobs)
        .set({ status: "streaming", updatedAt: new Date() })
        .where(eq(runnerJobs.id, jobId));
    }

    // Compute the next seq for this run. heartbeat_run_events.seq is per-run
    // monotonically increasing; we hold a one-shot SELECT max() lock by
    // querying inside the same connection — under heavy concurrent batches
    // from the SAME runner this is racey, but a runner only has one socket
    // open per job (claim is exclusive), so concurrent appends on the same
    // jobId are not in the v0 threat model. Cross-job batches are partitioned
    // by run_id and don't race.
    const events = req.body.events as z.infer<typeof eventBatchSchema>["events"];
    const [{ maxSeq }] = await db.execute(
      sql`select coalesce(max(${heartbeatRunEvents.seq}), 0) as "maxSeq" from ${heartbeatRunEvents} where ${heartbeatRunEvents.runId} = ${job.heartbeatRunId}`,
    ) as unknown as Array<{ maxSeq: number }>;
    let seq = Number(maxSeq) || 0;

    const rows = events.map((evt) => {
      seq += 1;
      const payload =
        typeof evt.payload === "string"
          ? { text: evt.payload, eventId: evt.eventId }
          : { ...(evt.payload ?? {}), eventId: evt.eventId };
      return {
        companyId,
        runId: job.heartbeatRunId,
        agentId: job.agentId,
        seq,
        eventType: evt.kind,
        // pino-style stream tag for stdout/stderr lines, null for claude_*
        stream:
          evt.kind === "stdout_line" ? "stdout" : evt.kind === "stderr_line" ? "stderr" : null,
        level: null,
        color: null,
        message: typeof evt.payload === "string" ? evt.payload : null,
        payload,
        createdAt: new Date(evt.ts),
      };
    });

    await db.insert(heartbeatRunEvents).values(rows);
    res.status(204).end();
  });

  /**
   * POST /jobs/:id/complete — terminal state. Persists exit code + cost +
   * session id. Rejects double-completion. Audit log entry distinguishes
   * success from failure via `runner.job.completed` vs `runner.job.failed`.
   */
  router.post("/jobs/:id/complete", validate(completeBodySchema), async (req, res) => {
    const jobId = req.params.id as string;
    const { tokenId, companyId } = ensureRunner(req);
    const body = req.body as z.infer<typeof completeBodySchema>;

    const [job] = await db
      .select({
        id: runnerJobs.id,
        companyId: runnerJobs.companyId,
        agentId: runnerJobs.agentId,
        heartbeatRunId: runnerJobs.heartbeatRunId,
        status: runnerJobs.status,
        claimedByTokenId: runnerJobs.claimedByTokenId,
      })
      .from(runnerJobs)
      .where(eq(runnerJobs.id, jobId))
      .limit(1);

    if (!job || job.companyId !== companyId) throw notFound("job_not_found");
    if (job.claimedByTokenId !== tokenId) throw forbidden("job_not_owned_by_token");
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      throw conflict("job_already_terminal", { status: job.status });
    }

    const newStatus: RunnerJobStatus = body.status;
    const elapsedMs = body.elapsedSec !== undefined ? Math.round(body.elapsedSec * 1000) : null;

    await db
      .update(runnerJobs)
      .set({
        status: newStatus,
        completedAt: new Date(),
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        elapsedMs: elapsedMs,
        costMicros: body.costMicros ?? null,
        sessionIdAfter: body.sessionId ?? null,
        cliVersion: body.cliVersion ?? null,
        errorMessage: body.errorMessage ?? null,
        updatedAt: new Date(),
      })
      .where(eq(runnerJobs.id, jobId));

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: `runner:${tokenId}`,
      action: newStatus === "completed" ? "runner.job.completed" : "runner.job.failed",
      entityType: "runner_job",
      entityId: jobId,
      agentId: job.agentId,
      runId: job.heartbeatRunId,
      details: {
        status: newStatus,
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        elapsedSec: body.elapsedSec ?? null,
        costMicros: body.costMicros ?? null,
        cliVersion: body.cliVersion ?? null,
      },
    });

    res.status(204).end();
  });

  return router;
}

// ─── Token-management routes (auth: session) ────────────────────────────────

/**
 * Mounted inside the existing `api` Router (so boardMutationGuard + actor
 * resolution + ALS context are already in place):
 *
 *     api.use(runnerTokenManagementRoutes(db));
 *
 * Registers paths under `/companies/:companyId/...`.
 */
export function runnerTokenManagementRoutes(db: Db): Router {
  const router = Router();

  /**
   * Confirms the company exists and the actor has access — returns nothing,
   * throws on miss. Centralizes the two preconditions every token route shares.
   */
  const requireCompanyAccess: RequestHandler = async (req, _res, next) => {
    try {
      const companyId = req.params.companyId as string;
      const [company] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("company_not_found");
      assertCompanyAccess(req, companyId);
      next();
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /companies/:companyId/runner-tokens — issue a new token. Plaintext
   * is shown ONCE in the response; only the sha256 hash is persisted. Audit
   * log row written before the response so a successful 201 implies an
   * audit-discoverable issuance event.
   *
   * Authorization: company owner or instance-admin. SaaS founders need to
   * issue a runner token for their own company so Claude Code can execute on
   * their local machine. local_implicit remains allowed for dev/QA.
   */
  router.post(
    "/companies/:companyId/runner-tokens",
    validate(issueTokenBodySchema),
    requireCompanyAccess,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageRunnerTokens(db, req, companyId);
      const body = req.body as z.infer<typeof issueTokenBodySchema>;
      const label = body.label ?? "";
      // W0.3 — `undefined` → 90-day default; explicit `null` → indefinite.
      const expiresAt = ttlDaysToExpiresAt(body.expiresInDays);

      const plaintext = generateRunnerToken();
      const tokenHash = sha256Hex(plaintext);

      // The `created_by_user_id` column FKs into the Better Auth "user" table.
      // For local_implicit dev mode the actor.userId is the synthetic
      // LOCAL_BOARD_USER_ID which has no row in "user" — store null so the FK
      // doesn't violate. Real session users keep the audit anchor.
      const isSyntheticPrincipal =
        req.actor.source === "local_implicit" || req.actor.userId === LOCAL_BOARD_USER_ID;
      const createdByUserId = isSyntheticPrincipal ? null : req.actor.userId ?? null;

      const [row] = await db
        .insert(runnerTokens)
        .values({
          companyId,
          tokenHash,
          label,
          createdByUserId,
          expiresAt,
        })
        .returning({
          id: runnerTokens.id,
          label: runnerTokens.label,
          createdAt: runnerTokens.createdAt,
          expiresAt: runnerTokens.expiresAt,
        });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "runner.token.issued",
        entityType: "runner_token",
        entityId: row.id,
        details: {
          tokenId: row.id,
          label: row.label,
          // BYO-105 — explicit issuer field so audit-export tools that read
          // `details` directly (without joining activityLog.actorId) still see
          // who minted the token. Mirrors `actorId` for self-contained rows.
          issuedByUserId: req.actor.userId ?? null,
          // Plaintext token deliberately NOT in details — only the first 8
          // chars for ops reference. The full token is response-only.
          tokenPreview: `${plaintext.slice(0, 8)}…`,
          // W0.3 — durably record TTL choice for audit. `null` = indefinite.
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        },
      });

      res.status(201).json({
        tokenId: row.id,
        token: plaintext,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      });
    },
  );

  /**
   * DELETE /companies/:companyId/runner-tokens/:tokenId — revoke. Sets
   * `revokedAt = now()`. Audit-only soft-delete: we keep the row so we can
   * still answer "which token issued this audit log entry?" later.
   */
  router.delete(
    "/companies/:companyId/runner-tokens/:tokenId",
    requireCompanyAccess,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageRunnerTokens(db, req, companyId);
      const tokenId = req.params.tokenId as string;

      const [target] = await db
        .select({ id: runnerTokens.id, label: runnerTokens.label, revokedAt: runnerTokens.revokedAt })
        .from(runnerTokens)
        .where(and(eq(runnerTokens.id, tokenId), eq(runnerTokens.companyId, companyId)))
        .limit(1);

      if (!target) throw notFound("runner_token_not_found");
      if (target.revokedAt) {
        // Idempotent — already revoked. 204 keeps the operation safe to retry.
        res.status(204).end();
        return;
      }

      await db
        .update(runnerTokens)
        .set({ revokedAt: new Date() })
        .where(eq(runnerTokens.id, tokenId));

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "runner.token.revoked",
        entityType: "runner_token",
        entityId: tokenId,
        details: {
          tokenId,
          label: target.label,
          // BYO-106 — explicit revoker field. Pairs with issuedByUserId in
          // runner.token.issued so the audit-export "who issued / who
          // revoked / when" pivot is self-contained per row.
          revokedByUserId: req.actor.userId ?? null,
        },
      });

      res.status(204).end();
    },
  );

  /**
   * W0.3 (council 2026-05-05) —
   * POST /companies/:companyId/runner-tokens/:tokenId/rotate
   *
   * Mint-new-then-revoke-old in a single transaction. Preserves the audit
   * chain via `rotated_from_token_id` so a recursive CTE can answer "every
   * token that descended from compromised token X". The rotation does NOT
   * require the prior token to be active — operators may rotate a recently
   * revoked or expired token to recover access without re-onboarding from
   * scratch (the new token is always active + within TTL regardless of the
   * old token's terminal state).
   *
   * Plaintext is shown ONCE in the 201 response, same as issuance.
   */
  router.post(
    "/companies/:companyId/runner-tokens/:tokenId/rotate",
    validate(rotateTokenBodySchema),
    requireCompanyAccess,
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageRunnerTokens(db, req, companyId);
      const oldTokenId = req.params.tokenId as string;
      const body = req.body as z.infer<typeof rotateTokenBodySchema>;

      const [old] = await db
        .select({
          id: runnerTokens.id,
          label: runnerTokens.label,
          revokedAt: runnerTokens.revokedAt,
        })
        .from(runnerTokens)
        .where(and(eq(runnerTokens.id, oldTokenId), eq(runnerTokens.companyId, companyId)))
        .limit(1);

      if (!old) throw notFound("runner_token_not_found");

      const plaintext = generateRunnerToken();
      const tokenHash = sha256Hex(plaintext);
      const expiresAt = ttlDaysToExpiresAt(body.expiresInDays);
      const label = body.label ?? old.label;

      const isSyntheticPrincipal =
        req.actor.source === "local_implicit" || req.actor.userId === LOCAL_BOARD_USER_ID;
      const createdByUserId = isSyntheticPrincipal ? null : req.actor.userId ?? null;

      // Atomic mint+revoke. If either side fails, neither row mutates — caller
      // can safely retry. We do NOT 409 if the old token is already revoked;
      // operators legitimately rotate from a revoked-by-incident token.
      const [created] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(runnerTokens)
          .values({
            companyId,
            tokenHash,
            label,
            createdByUserId,
            expiresAt,
            rotatedFromTokenId: old.id,
            deviceFingerprint: body.deviceFingerprint ?? null,
          })
          .returning({
            id: runnerTokens.id,
            label: runnerTokens.label,
            createdAt: runnerTokens.createdAt,
            expiresAt: runnerTokens.expiresAt,
          });

        // Idempotent revoke — only flip if not already revoked, so the
        // original `revokedAt` timestamp (incident time) is preserved.
        if (!old.revokedAt) {
          await tx
            .update(runnerTokens)
            .set({ revokedAt: new Date() })
            .where(eq(runnerTokens.id, old.id));
        }

        return inserted;
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "runner.token.rotated",
        entityType: "runner_token",
        entityId: created.id,
        details: {
          oldTokenId: old.id,
          newTokenId: created.id,
          label: created.label,
          rotatedByUserId: req.actor.userId ?? null,
          tokenPreview: `${plaintext.slice(0, 8)}…`,
          expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
          // Audit signal — surfaces "rotation came from a token that was
          // already revoked" (= recovery flow) vs "rotation pre-empted an
          // active token" (= scheduled refresh).
          oldTokenWasRevoked: !!old.revokedAt,
        },
      });

      res.status(201).json({
        tokenId: created.id,
        token: plaintext,
        label: created.label,
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        rotatedFromTokenId: old.id,
      });
    },
  );

  /**
   * GET /companies/:companyId/runner-status — liveness array consumed by the
   * dashboard. Excludes revoked tokens. `online` is `lastSeenAt within 30s`.
   */
  router.get("/companies/:companyId/runner-status", requireCompanyAccess, async (req, res) => {
    const companyId = req.params.companyId as string;
    const now = Date.now();

    const rows = await db
      .select({
        tokenId: runnerTokens.id,
        label: runnerTokens.label,
        createdAt: runnerTokens.createdAt,
        lastSeenAt: runnerTokens.lastSeenAt,
        expiresAt: runnerTokens.expiresAt,
      })
      .from(runnerTokens)
      .where(and(eq(runnerTokens.companyId, companyId), isNull(runnerTokens.revokedAt)))
      .orderBy(desc(runnerTokens.createdAt));

    res.status(200).json({
      tokens: rows.map((r) => ({
        tokenId: r.tokenId,
        label: r.label,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
        // W0.3 — surface expiresAt + a derived expiresInDays so the UI can
        // render "Expires in N days" without re-implementing the math.
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        expiresInDays: r.expiresAt
          ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now) / ONE_DAY_MS))
          : null,
        online: r.lastSeenAt ? now - r.lastSeenAt.getTime() <= RUNNER_ONLINE_WINDOW_MS : false,
      })),
    });
  });

  /**
   * GET /companies/:companyId/runner-tokens — list ALL tokens (active + revoked).
   *
   * BYO-105 — distinct from `/runner-status` which is the realtime liveness
   * dashboard (active-only). This endpoint backs the management UI's revoke
   * history view: shows revoked tokens with `revokedAt` populated so an admin
   * can audit "who issued / who revoked / when" at a glance. Plaintext tokens
   * are NEVER included — only `tokenId`, `label`, `createdAt`, `revokedAt`,
   * `lastSeenAt`, and the derived `online` boolean.
   */
  router.get("/companies/:companyId/runner-tokens", requireCompanyAccess, async (req, res) => {
    const companyId = req.params.companyId as string;
    const now = Date.now();

    const rows = await db
      .select({
        tokenId: runnerTokens.id,
        label: runnerTokens.label,
        createdAt: runnerTokens.createdAt,
        lastSeenAt: runnerTokens.lastSeenAt,
        revokedAt: runnerTokens.revokedAt,
        expiresAt: runnerTokens.expiresAt,
        rotatedFromTokenId: runnerTokens.rotatedFromTokenId,
      })
      .from(runnerTokens)
      .where(eq(runnerTokens.companyId, companyId))
      .orderBy(desc(runnerTokens.createdAt));

    res.status(200).json({
      tokens: rows.map((r) => ({
        tokenId: r.tokenId,
        label: r.label,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        expiresInDays: r.expiresAt
          ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now) / ONE_DAY_MS))
          : null,
        rotatedFromTokenId: r.rotatedFromTokenId,
        online:
          r.revokedAt === null && r.lastSeenAt !== null
            ? now - r.lastSeenAt.getTime() <= RUNNER_ONLINE_WINDOW_MS
            : false,
      })),
    });
  });

  return router;
}
