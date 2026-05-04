import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  /** Distributed-trace ID parsed from `traceparent` if present, else === requestId. */
  traceId: string;
  /** Subset of req.actor — useful for log/Sentry enrichment without leaking secrets. */
  actor?: {
    type?: string;
    userId?: string;
    companyId?: string;
    isInstanceAdmin?: boolean;
    source?: string;
    /**
     * BYO-109 — set by runner-auth middleware when type="runner". Surfaces
     * in pino logs as `actorRunnerTokenId` and on Sentry events as the
     * `runnerTokenId` tag, so a failing request can be traced back to the
     * specific token without quoting plaintext.
     */
    runnerTokenId?: string;
  };
  /** Express route path once matched (e.g. "/api/companies/:id"). */
  routePath?: string;
  method?: string;
  url?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Mutate the active request context. No-op if called outside one.
 * Used by actorMiddleware (after auth resolves) and route handlers
 * (after the matched route path is known) to enrich the same context
 * the request started with.
 */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

/**
 * Wrap a cron / setInterval / setTimeout callback body in a fresh request
 * context so logs and Sentry events from scheduled tasks carry a
 * requestId/traceId. Without this, getRequestContext() returns undefined
 * inside the timer callback (HTTP middleware never ran for this code path)
 * and the pino mixin + Sentry scope-enrichment silently emit empty tags.
 *
 * Usage: `setInterval(() => runInCronContext("name", () => { ... }), N)`.
 *
 * Council 2026-05-03 P2 (Gemini) — context loss in background crons.
 */
export function runInCronContext<T>(
  taskName: string,
  fn: () => T,
): T {
  const requestId = `cron:${taskName}:${randomUUID()}`;
  return storage.run(
    {
      requestId,
      traceId: requestId,
      actor: { type: "system", source: `cron:${taskName}` },
      routePath: `cron/${taskName}`,
    },
    fn,
  );
}
