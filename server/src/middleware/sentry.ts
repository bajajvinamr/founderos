import type { Request, Response, NextFunction } from "express";
import { captureServerError, isSentryEnabled } from "../observability/sentry.js";

/**
 * Sentry Express error handler middleware.
 *
 * Mount this AFTER all routes and BEFORE the final application error handler.
 * Captures exceptions to Sentry with full request-context enrichment
 * (requestId, traceId, actor, route) pulled from AsyncLocalStorage by
 * `captureServerError`, then passes to the next handler so the application
 * `errorHandler` can still send the response.
 *
 * Sentry.init() is called in index.ts during server boot; this middleware
 * is a no-op if SENTRY_DSN was unset.
 */
export function sentryErrorHandler(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (!isSentryEnabled()) {
    return next(err);
  }
  // captureServerError auto-merges the active request context (requestId,
  // traceId, actor, route, url) into the Sentry scope. No need to thread
  // them through manually here.
  captureServerError(err);
  next(err);
}
