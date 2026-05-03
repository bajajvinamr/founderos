// Request correlation middleware. Implements the W3C Trace Context spec
// (https://www.w3.org/TR/trace-context/) for the `traceparent` header so
// upstream proxies / Honeycomb / Datadog / Jaeger can correlate spans.
//
// Threat model: incoming `x-request-id` is attacker-supplied. We accept it
// for cross-service correlation but validate against a strict charset to
// block log injection (newlines/control chars), header splitting, and
// unbounded length. Anything that doesn't pass is replaced with a fresh
// UUID — the request still flows, just with our ID.

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { runWithRequestContext, type RequestContext } from "../lib/request-context.js";

const REQUEST_ID_HEADER = "x-request-id";
const TRACEPARENT_HEADER = "traceparent";
const TRACEPARENT_RE = /^\d{2}-([0-9a-f]{32})-([0-9a-f]{16})-\d{2}$/i;
// Conservative charset for upstream-supplied request IDs: hex, dash, underscore,
// dot. Excludes spaces, CR/LF, and any control char that would enable header
// splitting or log injection.
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function parseTraceparent(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  return match ? match[1] : null;
}

function acceptIncomingRequestId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return SAFE_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Generate or accept a request id, attach it to req/res and the
 * AsyncLocalStorage context so every log line, Sentry event, and
 * background async chain spawned during the request can be correlated.
 *
 * Mount BEFORE httpLogger so pino-http picks up `req.id`.
 */
export function requestIdMiddleware() {
  return function requestId(req: Request, res: Response, next: NextFunction): void {
    const accepted = acceptIncomingRequestId(req.header(REQUEST_ID_HEADER));
    const requestId = accepted ?? randomUUID();
    const traceId = parseTraceparent(req.header(TRACEPARENT_HEADER)) ?? requestId.replace(/-/g, "");

    // pino-http reads `req.id` for the `reqId` log field.
    (req as unknown as { id: string }).id = requestId;
    (req as unknown as { requestId: string }).requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const ctx: RequestContext = {
      requestId,
      traceId,
      method: req.method,
      url: req.originalUrl,
    };

    runWithRequestContext(ctx, () => next());
  };
}
