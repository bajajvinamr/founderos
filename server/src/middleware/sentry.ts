import type { Request, Response, NextFunction } from "express";
import { isSentryEnabled } from "../observability/sentry.js";

/**
 * Sentry Express error handler middleware.
 *
 * Mount this AFTER all routes and BEFORE the final application error handler.
 * It captures exceptions to Sentry if enabled, then passes to the next handler.
 *
 * Sentry.init() is called in index.ts during server boot.
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

  // If Sentry is enabled, try to import and use it for error capture.
  // This is a dynamic import so we don't hard-depend on Sentry being installed.
  void (async () => {
    try {
      const Sentry = await import("@sentry/node");
      Sentry.captureException(err);
    } catch {
      // Module not installed or other issue — proceed to next handler
    }
    next(err);
  })();
}
