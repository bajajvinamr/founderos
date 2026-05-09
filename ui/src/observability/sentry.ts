/**
 * Optional Sentry error tracking for the browser.
 *
 * Activation: set VITE_SENTRY_DSN at build time. If the var is absent, this
 * module is a no-op and no Sentry code even lands in the bundle at runtime
 * (thanks to import.meta.env dead-code elimination).
 *
 * We defer the actual init behind a dynamic import so the Sentry bundle
 * only downloads when it's going to be used.
 */

let initialized = false;

export async function initBrowserSentry(): Promise<void> {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || typeof dsn !== "string" || dsn.length === 0) return;

  const Sentry = await import("@sentry/react");
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    replaysSessionSampleRate: 0,   // opt-in only — default off for BYO-key deployments
    replaysOnErrorSampleRate: 0,
  });
  initialized = true;
}

export async function captureBrowserError(
  err: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  if (!initialized) return;
  const Sentry = await import("@sentry/react");
  Sentry.withScope((scope) => {
    if (context) for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    Sentry.captureException(err);
  });
}

/**
 * Capture an error and return the Sentry event ID so the UI can surface it
 * to the user (e.g. ErrorBoundary fallback "Reference: <id>"). Returns null
 * when Sentry is not initialized or the SDK declines to assign an event ID.
 */
export async function captureBrowserErrorWithEventId(
  err: unknown,
  context?: Record<string, unknown>,
): Promise<string | null> {
  if (!initialized) return null;
  const Sentry = await import("@sentry/react");
  let eventId: string | undefined;
  Sentry.withScope((scope) => {
    if (context) for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    eventId = Sentry.captureException(err);
  });
  return eventId ?? null;
}
