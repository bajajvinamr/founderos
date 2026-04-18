/**
 * Optional Sentry error tracking for the server.
 *
 * Activation: set SENTRY_DSN (and optionally SENTRY_ENVIRONMENT). If DSN is
 * empty, `initServerSentry` is a no-op and no Sentry code runs — keeps dev
 * + local_trusted deploys free of telemetry.
 *
 * Expose `captureServerError` as a thin wrapper so call sites don't need
 * to import Sentry conditionally; when disabled it's a silent passthrough.
 */

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
    });
    captureFn = (err, context) => {
      Sentry.withScope((scope) => {
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
