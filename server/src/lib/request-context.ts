import { AsyncLocalStorage } from "node:async_hooks";

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
