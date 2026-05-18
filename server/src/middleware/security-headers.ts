/**
 * security-headers.ts — restrictive baseline of HTTP security headers.
 *
 * Applied very early in the middleware stack (right after request-id) so
 * even error responses carry the headers. Hand-rolled instead of using
 * Helmet because we have a small, well-known set of external origins
 * that need allowlisting and Helmet's defaults would need overrides for
 * every single one of them.
 *
 * Origins allowlisted:
 *   self (founderos.fly.dev + any UI-served origin)        — API + WS + static
 *   *.supabase.co / *.supabase.in                          — auth + realtime
 *   api.composio.dev / backend.composio.dev                — Composio v3
 *   *.ingest.sentry.io / sentry.io                         — error reporting
 *   api.anthropic.com                                      — direct LLM calls
 *   js.stripe.com / api.stripe.com / hooks.stripe.com      — Stripe checkout
 *   registry.npmjs.org                                     — NPM package
 *                                                            version lookups
 *                                                            (AdapterManager)
 *
 * The CSP is intentionally NOT report-only. The 2026-05-03 council BLOCK
 * called out "no CSP" as a P1 — shipping report-only would still be a
 * "no enforcement" finding. If real users hit a CSP violation post-deploy,
 * pin the offending host as a follow-up; do not relax to report-only.
 */

import type { Request, Response, NextFunction } from "express";

export interface SecurityHeadersOptions {
  /**
   * Supabase project URL (e.g. https://ggspsiexqppduvsqvpgy.supabase.co).
   * When provided, the project's exact host is added to the allowlist —
   * the wildcard `*.supabase.co` already covers it, but pinning the
   * specific project host makes regressions visible (an unexpected
   * Supabase host in the CSP report points at an env-var swap).
   */
  supabaseUrl?: string | null;
  /**
   * Disable CSP entirely. Use ONLY for dev when testing third-party
   * integrations that haven't been allowlisted yet. NEVER set true in
   * production — env-validation should refuse to boot if it sees this.
   */
  disableCsp?: boolean;
}

const SUPABASE_HOSTS = "https://*.supabase.co https://*.supabase.in wss://*.supabase.co wss://*.supabase.in";
const COMPOSIO_HOSTS = "https://api.composio.dev https://backend.composio.dev";
const SENTRY_HOSTS = "https://*.ingest.sentry.io https://sentry.io";
const ANTHROPIC_HOSTS = "https://api.anthropic.com";
const STRIPE_HOSTS = "https://api.stripe.com https://hooks.stripe.com";
const STRIPE_FRAME = "https://js.stripe.com https://hooks.stripe.com";
const STRIPE_SCRIPT = "https://js.stripe.com";
// NPM registry — UI's AdapterManager fetches latest package versions via
// `https://registry.npmjs.org/<pkg>/latest`. Without this entry the request
// is blocked by CSP with no observable error in app code (L2-F01).
const NPM_REGISTRY_HOSTS = "https://registry.npmjs.org";

export function buildContentSecurityPolicy(opts: SecurityHeadersOptions): string {
  const supabaseExact = opts.supabaseUrl ? new URL(opts.supabaseUrl).origin : "";
  const supabaseWs = supabaseExact ? supabaseExact.replace(/^https/, "wss") : "";
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Tailwind v4 + React inline styles need 'unsafe-inline' for now.
    // Stripe.js loads from js.stripe.com.
    "script-src": ["'self'", "'unsafe-inline'", STRIPE_SCRIPT],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "ws:",
      "wss:",
      SUPABASE_HOSTS,
      ...(supabaseExact ? [supabaseExact, supabaseWs] : []),
      COMPOSIO_HOSTS,
      SENTRY_HOSTS,
      ANTHROPIC_HOSTS,
      STRIPE_HOSTS,
      NPM_REGISTRY_HOSTS,
    ],
    "frame-src": ["'self'", STRIPE_FRAME],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/**
 * Express middleware adding the baseline security headers to every
 * response — including error paths. Mount BEFORE any route handler.
 */
export function securityHeadersMiddleware(opts: SecurityHeadersOptions = {}) {
  const csp = opts.disableCsp ? null : buildContentSecurityPolicy(opts);
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (csp) res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // HSTS is only meaningful over HTTPS. Fly terminates TLS so browsers
    // see HTTPS regardless; the header is safe to always emit.
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
    next();
  };
}
