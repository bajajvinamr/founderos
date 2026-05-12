/**
 * Optional Sentry error tracking for the server.
 *
 * Activation: set SENTRY_DSN (and optionally SENTRY_ENVIRONMENT). If DSN is
 * empty, `initServerSentry` is a no-op and no Sentry code runs — keeps dev
 * + local_trusted deploys free of telemetry.
 *
 * Expose `captureServerError` as a thin wrapper so call sites don't need
 * to import Sentry conditionally; when disabled it's a silent passthrough.
 *
 * Auto-enrichment: every captured error is augmented with the active
 * AsyncLocalStorage request context (requestId, traceId, actor, route)
 * so Sentry events are correlatable with pino logs and the response
 * `x-request-id` header. Callers can pass extra context via the second arg.
 */

import { getRequestContext } from "../lib/request-context.js";

let initialized = false;
let captureFn: ((err: unknown, context?: Record<string, unknown>) => void) | null = null;

export async function initServerSentry(): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  if (initialized) return true;

  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
      sendDefaultPii: false,
      beforeBreadcrumb(breadcrumb) {
        // TA02 council condition #4: scrub Gemini API key-bearing URLs from
        // Sentry breadcrumbs before they are sent.
        // generativelanguage.googleapis.com URLs contain ?key=<apikey> as a
        // query parameter — these must never appear in Sentry.
        if (
          breadcrumb.data?.url &&
          typeof breadcrumb.data.url === "string" &&
          breadcrumb.data.url.includes("generativelanguage.googleapis.com")
        ) {
          breadcrumb.data = {
            ...breadcrumb.data,
            url: "[scrubbed: gemini-api-key-url]",
          };
        }
        return breadcrumb;
      },
    });
    captureFn = (err, context) => {
      Sentry.withScope((scope) => {
        const ctx = getRequestContext();
        if (ctx) {
          scope.setTag("requestId", ctx.requestId);
          scope.setTag("traceId", ctx.traceId);
          if (ctx.routePath) scope.setTag("routePath", ctx.routePath);
          if (ctx.method) scope.setTag("httpMethod", ctx.method);
          if (ctx.actor) {
            scope.setUser({
              id: ctx.actor.userId,
              segment: ctx.actor.type,
            });
            scope.setTag("actorType", ctx.actor.type ?? "none");
            if (ctx.actor.companyId) scope.setTag("companyId", ctx.actor.companyId);
            if (ctx.actor.isInstanceAdmin !== undefined) {
              scope.setTag("isInstanceAdmin", String(ctx.actor.isInstanceAdmin));
            }
            // BYO-109 — runner identity tag. Lets ops filter Sentry by
            // tag:runnerTokenId to find every error issued by a specific
            // token (handy when a runner upgrades and a regression slips in).
            if (ctx.actor.runnerTokenId) {
              scope.setTag("runnerTokenId", ctx.actor.runnerTokenId);
            }
          }
          scope.setExtra("url", ctx.url);
        }
        if (context) {
          for (const [k, v] of Object.entries(context)) {
            scope.setExtra(k, v);
          }
        }
        Sentry.captureException(err);
      });
    };
    initialized = true;
    return true;
  } catch {
    // Module not installed → graceful no-op.
    return false;
  }
}

export function captureServerError(err: unknown, context?: Record<string, unknown>): void {
  if (captureFn) captureFn(err, context);
}

export function isSentryEnabled(): boolean {
  return initialized;
}
