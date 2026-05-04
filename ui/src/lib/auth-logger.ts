/**
 * Auth-failure capture — structured logging for every Supabase auth call.
 *
 * Why a separate module instead of inline in supabase.ts:
 *  - Avoids a circular import between supabase.ts and observability/sentry.ts
 *  - Keeps the in-memory ring buffer of recent errors (for window.__authDebug)
 *    in one place
 *  - Lets the AuthBrokenStartPage import recent errors without dragging the
 *    Supabase SDK into the error-page chunk
 */

import { captureBrowserError } from "../observability/sentry";

interface AuthError {
  /** The auth surface that failed: signup, signin-google, signin-password, get-session, supabase-fetch, config-error, etc. */
  source: string;
  message: string;
  ts: string;
  context: Record<string, unknown>;
  stack?: string;
}

const RING_SIZE = 25;
const ringBuffer: AuthError[] = [];

interface AuthBreadcrumb {
  category: string;
  data: Record<string, unknown>;
  ts: string;
}

const BREADCRUMB_RING_SIZE = 50;
const breadcrumbBuffer: AuthBreadcrumb[] = [];

export function addAuthBreadcrumb(category: string, data: Record<string, unknown>): void {
  const crumb: AuthBreadcrumb = {
    category,
    data,
    ts: new Date().toISOString(),
  };
  breadcrumbBuffer.push(crumb);
  if (breadcrumbBuffer.length > BREADCRUMB_RING_SIZE) {
    breadcrumbBuffer.shift();
  }
}

export function captureAuthError(
  source: string,
  err: Error,
  context: Record<string, unknown> = {},
): void {
  const entry: AuthError = {
    source,
    message: err.message,
    ts: new Date().toISOString(),
    context,
    stack: err.stack,
  };
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_SIZE) {
    ringBuffer.shift();
  }

  // eslint-disable-next-line no-console
  console.error(`[auth-error][${source}]`, {
    message: err.message,
    ...context,
    ts: entry.ts,
  });

  // Best-effort Sentry capture; no-op if Sentry isn't initialized.
  void captureBrowserError(err, {
    source,
    breadcrumbs: breadcrumbBuffer.slice(-10),
    ...context,
  });
}

export function getRecentAuthErrors(): readonly AuthError[] {
  return ringBuffer;
}

export function getRecentAuthBreadcrumbs(): readonly AuthBreadcrumb[] {
  return breadcrumbBuffer;
}

// Expose recent errors to DevTools for self-service debugging.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__authErrors = () => {
    // eslint-disable-next-line no-console
    console.table(ringBuffer.map((e) => ({ source: e.source, message: e.message, ts: e.ts })));
    return ringBuffer;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__authBreadcrumbs = () => {
    // eslint-disable-next-line no-console
    console.table(breadcrumbBuffer.map((c) => ({ category: c.category, ts: c.ts, ...c.data })));
    return breadcrumbBuffer;
  };
}
