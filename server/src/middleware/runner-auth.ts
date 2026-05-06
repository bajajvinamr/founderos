/**
 * BYO-101 — Runner-token auth middleware (ADR-011, threat model T1+T2).
 *
 * Resolves `Authorization: Bearer fos_<32-char>` headers to a runner token
 * + companyId. Sets `req.actor` so downstream handlers + the existing pino
 * mixin + Sentry scope auto-enrich logs with the runner identity.
 *
 * Threat-model coverage:
 *   T1 (token leak):  sha256-only at rest, constant-time compare on lookup,
 *                     plaintext never logged (only first 8 chars + tokenId).
 *   T2 (escalation):  token resolves to ONE companyId; downstream routes
 *                     verify path :companyId === req.actor.companyId.
 *   T5 (MITM):        TLS termination handled at Fly edge; non-HTTPS requests
 *                     are an HTTP-vs-runtime concern, not this middleware's.
 *
 * lastSeenAt is updated on every successful auth — drives the dashboard
 * liveness indicator (online when lastSeenAt < 30s ago). Debounced to one
 * write per 30s per token to keep the hot path cheap during the 5s poll
 * loop the runner uses (see ADR-011).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response, NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { runnerTokens } from "@founderos/db";
import { logger } from "./logger.js";
import { runWithRequestContext, getRequestContext } from "../lib/request-context.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Plaintext token format: `fos_` prefix + exactly 32 alphanumeric chars. */
const TOKEN_FORMAT = /^fos_[A-Za-z0-9]{32}$/;

/** Debounce lastSeenAt writes to once per 30s per token id. Runner polls
 *  every 5s, so without this we'd write 12x as many rows as needed. */
const LAST_SEEN_DEBOUNCE_MS = 30_000;

const lastSeenWritten = new Map<string, number>();

// Bound the in-process cache so a long-running server with many distinct
// tokens (test fixtures churn, key rotations) doesn't grow it unboundedly.
const MAX_TRACKED_TOKENS = 4096;

function shouldWriteLastSeen(tokenId: string): boolean {
  const now = Date.now();
  const last = lastSeenWritten.get(tokenId);
  if (last !== undefined && now - last < LAST_SEEN_DEBOUNCE_MS) return false;
  if (lastSeenWritten.size >= MAX_TRACKED_TOKENS) {
    // Insertion-order eviction; Map preserves insertion order so this is O(1).
    const oldest = lastSeenWritten.keys().next().value;
    if (oldest !== undefined) lastSeenWritten.delete(oldest);
  }
  lastSeenWritten.set(tokenId, now);
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute sha256 hex of a plaintext token.
 *
 * Public for tests + the issuance route; never call this with anything
 * other than a validated TOKEN_FORMAT string.
 */
export function hashRunnerToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Constant-time hex string compare. The DB lookup already filters by hash,
 * but we still re-verify the returned hash matches — defense in depth
 * against a hypothetical SQL-layer mistake or middleware reordering.
 *
 * Both inputs MUST already be the same length (sha256 hex = 64 chars).
 * Throws if not — caller is responsible for length validation, since
 * leaking a "wrong length" 401 vs "wrong hash" 401 is a tiny information
 * leak we'd rather not have.
 */
function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

function unauthorized(res: Response, requestId: string | undefined): void {
  res.status(401).json({ error: "invalid_runner_token", requestId });
}

/**
 * Council 2026-05-05 W0.3 — surface expiry distinctly so the runner CLI
 * can prompt for rotation instead of silently 401'ing in a poll loop. The
 * `code` shape lets the runner package switch on the failure cleanly without
 * regex-matching error strings. The plaintext token is NEVER echoed.
 */
function expired(res: Response, requestId: string | undefined, expiredAt: Date): void {
  res.status(401).json({
    error: "runner_token_expired",
    code: "expired",
    expiredAt: expiredAt.toISOString(),
    rotationHint:
      "Run `founderos auth rotate-runner-token` from the laptop, or mint a new token from the dashboard.",
    requestId,
  });
}

// ─── Middleware ─────────────────────────────────────────────────────────────

/**
 * Build the runner-auth middleware. Mount it on the runner-only routes:
 *
 *     app.use("/api/runner", runnerAuth(db));
 *
 * Does NOT replace `actorMiddleware` — runs in addition to it on a
 * dedicated route prefix. The runner endpoints have their own auth surface
 * (no session cookies, no agent JWTs, just bearer tokens).
 */
export function runnerAuthMiddleware(db: Db): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.header("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      unauthorized(res, req.requestId);
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();

    // Format gate before DB hit — short-circuits malformed input cheaply.
    // Note: a malformed-vs-mismatch distinction would be a tiny info leak
    // (T1/M1.5), so we collapse both to the same 401 / "invalid_runner_token"
    // shape regardless of the failure reason.
    if (!TOKEN_FORMAT.test(token)) {
      unauthorized(res, req.requestId);
      return;
    }

    const expectedHash = hashRunnerToken(token);

    let row:
      | {
          id: string;
          companyId: string;
          tokenHash: string;
          revokedAt: Date | null;
          expiresAt: Date | null;
        }
      | undefined;
    try {
      const result = await db
        .select({
          id: runnerTokens.id,
          companyId: runnerTokens.companyId,
          tokenHash: runnerTokens.tokenHash,
          revokedAt: runnerTokens.revokedAt,
          // W0.3 — pull expires_at so the middleware can reject on TTL.
          expiresAt: runnerTokens.expiresAt,
        })
        .from(runnerTokens)
        .where(and(eq(runnerTokens.tokenHash, expectedHash), isNull(runnerTokens.revokedAt)))
        .limit(1);
      row = result[0];
    } catch (err) {
      logger.error(
        { err, requestId: req.requestId },
        "runner-auth: db lookup failed — declining the request",
      );
      unauthorized(res, req.requestId);
      return;
    }

    if (!row) {
      unauthorized(res, req.requestId);
      return;
    }

    // Constant-time defense-in-depth re-check. The WHERE clause already
    // filtered on tokenHash, but if a future migration breaks the index or
    // someone bypasses the WHERE in a refactor, this still catches it.
    if (!safeHashEquals(row.tokenHash, expectedHash)) {
      unauthorized(res, req.requestId);
      return;
    }

    // W0.3 (council 2026-05-05) — TTL gate. expires_at IS NULL means a
    // legacy token issued before migration 0089; those continue to work
    // until manually revoked or rotated. Non-NULL + past = reject with
    // `code: "expired"` + rotationHint so the CLI can prompt cleanly.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      logger.info(
        { tokenId: row.id, expiredAt: row.expiresAt, requestId: req.requestId },
        "runner-auth: token expired",
      );
      expired(res, req.requestId, row.expiresAt);
      return;
    }

    // Touch lastSeenAt (debounced). Async — fire-and-forget; we don't want
    // the runner's poll to wait on a write that's purely for UI liveness.
    if (shouldWriteLastSeen(row.id)) {
      const now = new Date();
      db.update(runnerTokens)
        .set({ lastSeenAt: now })
        .where(eq(runnerTokens.id, row.id))
        .then(() => {
          /* no-op; debounce-tracked already */
        })
        .catch((err) => {
          // Don't fail the request on lastSeenAt write — it's UI metadata.
          logger.warn(
            { err, tokenId: row?.id, requestId: req.requestId },
            "runner-auth: lastSeenAt update failed (non-fatal)",
          );
        });
    }

    req.actor = {
      type: "runner",
      companyId: row.companyId,
      runnerTokenId: row.id,
      source: "runner_token",
    };

    // Enrich the active request context so the pino mixin + Sentry scope
    // auto-tag log lines + breadcrumbs with the runner identity. BYO-109 —
    // include runnerTokenId so support engineers can correlate a single
    // failing request back to the specific token without quoting plaintext.
    // If we're not running inside an existing context (test code path),
    // open one.
    const existing = getRequestContext();
    const runnerActor = {
      type: "runner",
      companyId: row.companyId,
      source: "runner_token",
      runnerTokenId: row.id,
    } as const;
    if (existing) {
      existing.actor = { ...runnerActor };
      next();
      return;
    }

    runWithRequestContext(
      {
        requestId: req.requestId ?? row.id,
        traceId: req.requestId ?? row.id,
        actor: { ...runnerActor },
      },
      () => next(),
    );
  };
}

// ─── Test seam ──────────────────────────────────────────────────────────────

/** Visible for tests — clears the in-process lastSeenAt debounce cache. */
export function __clearRunnerAuthDebounceCache(): void {
  lastSeenWritten.clear();
}
