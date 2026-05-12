/**
 * security-headers-shape — structural canary for HTTP security headers.
 *
 * Why this spec exists:
 *   Security headers are silent contracts. When one is missing or weakened
 *   (a refactor swaps `X-Frame-Options: DENY` for `SAMEORIGIN`, someone
 *   removes the `connect-src` clamp, a wildcard `*` slips into a privacy-
 *   critical directive), there is no app-side error and no visible regression
 *   in QA — just a future browser blocking a legitimate XHR with no console
 *   trace in the app code that called it.
 *
 *   Two Loop 2 fixes already burned time on this exact failure mode:
 *     - L2-F01 (PR #207): `connect-src` was missing `https://registry.npmjs.org`,
 *       so `ui/src/pages/AdapterManager.tsx` silently failed all NPM version
 *       lookups against the browser CSP. App code threw no error — feature
 *       just looked broken.
 *     - L2-F04 (this phase): a separate font-loading regression caused by a
 *       CSP directive omission of the same shape.
 *
 *   A header-shape smoke test makes the contract observable in CI before the
 *   regression reaches a user. It runs against the deployed origin (default
 *   `https://founderos.fly.dev`, overridable via `FOUNDEROS_E2E_BASE_URL`)
 *   and asserts only the things that MUST be true on every successful page
 *   load — not the things that COULD be true.
 *
 * What this spec asserts:
 *   - `X-Frame-Options` is `DENY` or `SAMEORIGIN` (never missing, never the
 *     obsolete `ALLOW-FROM` variant).
 *   - `X-Content-Type-Options` is exactly `nosniff` — anything else (or
 *     missing) re-enables MIME sniffing and is a regression.
 *   - `Referrer-Policy` is one of the privacy-preserving values; specifically
 *     NOT `unsafe-url` and not missing entirely.
 *   - `Content-Security-Policy` exists AND:
 *       * declares `default-src`
 *       * `connect-src` includes `'self'` and the L2-F01 allowlist host
 *       * `script-src` does NOT contain `'unsafe-eval'`
 *       * `frame-ancestors` is locked to `'none'` or `'self'` (no wildcard
 *         clickjacking surface)
 *       * none of the privacy-critical directives use a bare `*` wildcard
 *
 * What this spec does NOT do:
 *   - Mutate any data (read-only GET against `/`).
 *   - Assert HSTS / Permissions-Policy / additional headers — those are
 *     stricter than the cross-browser minimum bar this canary holds.
 *   - Assert the full host allowlist (Supabase, Composio, Sentry, Anthropic,
 *     Stripe). Those are enforcement details of the current middleware that
 *     legitimately churn; this spec only pins the contracts whose regression
 *     would be a silent feature break.
 *
 * Profile:
 *   Public-only profile — runs against any deployed origin without auth.
 *   Safe to run on prod, against a Fly review app, or locally.
 */
import { expect, test } from "../fixtures";

/**
 * Privacy-critical CSP directives — these are the ones where a bare `*`
 * wildcard would actively defeat the policy's purpose. `img-src` and
 * `font-src` legitimately use broad allowances; they are excluded.
 */
const PRIVACY_CRITICAL_DIRECTIVES = [
  "default-src",
  "script-src",
  "connect-src",
  "frame-ancestors",
] as const;

/**
 * Allowed values for `Referrer-Policy`. `no-referrer-when-downgrade` is the
 * browser default and acceptable but kept out — we explicitly want the
 * server to set one of the privacy-preserving values so a future spec-default
 * change can't silently downgrade the policy.
 */
const ALLOWED_REFERRER_POLICIES = new Set([
  "no-referrer",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "same-origin",
]);

/**
 * Allowed values for `X-Frame-Options`. `ALLOW-FROM` was a draft variant
 * that is obsolete + ignored by modern browsers; treating it as "set" would
 * give a false-positive green.
 */
const ALLOWED_X_FRAME_OPTIONS = new Set(["DENY", "SAMEORIGIN"]);

/**
 * Parse a `Content-Security-Policy` header into a directive → tokens map.
 * Tolerates leading/trailing whitespace and empty segments from a trailing
 * `;`. Directive name is normalized to lower-case (CSP directives are
 * case-insensitive); tokens preserve original case (`'self'` etc.).
 */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of header.split(";")) {
    const seg = raw.trim();
    if (!seg) continue;
    const parts = seg.split(/\s+/);
    const name = parts[0].toLowerCase();
    out[name] = parts.slice(1);
  }
  return out;
}

test.describe("[security-headers-shape] response carries restrictive header contract", () => {
  test("[security-headers-shape] GET / ships all four canary headers with the expected shape", async ({
    request,
  }) => {
    // The landing route is the right probe — it's public, returns HTML, and
    // is the page every user hits before any auth state exists. The headers
    // middleware sits before route handlers so we'd see the same contract
    // on any path, but `/` is the one that ships HTML to a real browser and
    // therefore where header shape matters most.
    const response = await request.get("/", {
      headers: {
        // The default UA includes our synthetic-probe tag so backend log
        // heuristics can identify these runs.
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    expect(
      response.ok(),
      `expected 2xx from GET / for security-headers probe, got ${response.status()}`,
    ).toBe(true);

    const headers = response.headers();

    // ------------------------------------------------------------------
    // X-Frame-Options
    // ------------------------------------------------------------------
    const xfo = headers["x-frame-options"];
    expect(
      xfo,
      "X-Frame-Options header missing — clickjacking surface re-opened",
    ).toBeDefined();
    expect(
      ALLOWED_X_FRAME_OPTIONS.has(xfo!.trim().toUpperCase()),
      `X-Frame-Options must be DENY or SAMEORIGIN, got "${xfo}"`,
    ).toBe(true);

    // ------------------------------------------------------------------
    // X-Content-Type-Options
    // ------------------------------------------------------------------
    const xcto = headers["x-content-type-options"];
    expect(
      xcto,
      "X-Content-Type-Options header missing — MIME sniffing re-enabled",
    ).toBeDefined();
    expect(
      xcto!.trim().toLowerCase(),
      `X-Content-Type-Options must be exactly "nosniff", got "${xcto}"`,
    ).toBe("nosniff");

    // ------------------------------------------------------------------
    // Referrer-Policy
    // ------------------------------------------------------------------
    const referrer = headers["referrer-policy"];
    expect(
      referrer,
      "Referrer-Policy header missing — defaults to unsafe-url on older browsers",
    ).toBeDefined();
    const normalizedReferrer = referrer!.trim().toLowerCase();
    expect(
      ALLOWED_REFERRER_POLICIES.has(normalizedReferrer),
      `Referrer-Policy must be one of ${Array.from(ALLOWED_REFERRER_POLICIES).join(
        ", ",
      )} — got "${referrer}"`,
    ).toBe(true);
    expect(
      normalizedReferrer,
      "Referrer-Policy must NOT be unsafe-url",
    ).not.toBe("unsafe-url");

    // ------------------------------------------------------------------
    // Content-Security-Policy — structure + privacy directives
    // ------------------------------------------------------------------
    const csp = headers["content-security-policy"];
    expect(
      csp,
      "Content-Security-Policy header missing — CSP enforcement gone",
    ).toBeDefined();

    const directives = parseCsp(csp!);

    // default-src present
    expect(
      directives["default-src"],
      "CSP must declare a default-src directive",
    ).toBeDefined();
    expect(directives["default-src"].length).toBeGreaterThan(0);

    // connect-src present, includes 'self', and the L2-F01 allowlist host.
    // The registry.npmjs.org entry is the canary for "new outbound XHR
    // origin → CSP update in the same commit." If this assertion ever
    // regresses, ui/src/pages/AdapterManager.tsx will silently 0-out its
    // NPM version lookups in prod with no app-code error — exactly the
    // failure mode L2-F01 just fixed.
    const connectSrc = directives["connect-src"];
    expect(
      connectSrc,
      "CSP must declare a connect-src directive",
    ).toBeDefined();
    expect(
      connectSrc.includes("'self'"),
      `CSP connect-src must include 'self' — got: ${connectSrc.join(" ")}`,
    ).toBe(true);
    expect(
      connectSrc.includes("https://registry.npmjs.org"),
      `CSP connect-src must include https://registry.npmjs.org (L2-F01 PR #207) — got: ${connectSrc.join(
        " ",
      )}`,
    ).toBe(true);

    // script-src declared and does NOT include 'unsafe-eval'.
    // 'unsafe-inline' is currently tolerated (Tailwind v4 + React inline
    // styles need it per the middleware comment); 'unsafe-eval' is NOT.
    const scriptSrc = directives["script-src"];
    expect(
      scriptSrc,
      "CSP must declare a script-src directive",
    ).toBeDefined();
    expect(
      scriptSrc.includes("'unsafe-eval'"),
      `CSP script-src must NOT include 'unsafe-eval' — got: ${scriptSrc.join(" ")}`,
    ).toBe(false);

    // frame-ancestors locked down
    const frameAncestors = directives["frame-ancestors"];
    expect(
      frameAncestors,
      "CSP must declare a frame-ancestors directive (clickjacking defense)",
    ).toBeDefined();
    expect(
      frameAncestors.length === 1 &&
        (frameAncestors[0] === "'none'" || frameAncestors[0] === "'self'"),
      `CSP frame-ancestors must be exactly 'none' or 'self' — got: ${frameAncestors.join(
        " ",
      )}`,
    ).toBe(true);

    // No bare `*` in privacy-critical directives. We allow scheme-qualified
    // wildcards like `https:` or `https://*.supabase.co` (those still bind
    // to a scheme + host pattern); a bare `*` token defeats the directive
    // entirely.
    for (const name of PRIVACY_CRITICAL_DIRECTIVES) {
      const tokens = directives[name];
      if (!tokens) continue;
      expect(
        tokens.includes("*"),
        `CSP ${name} must not contain a bare "*" wildcard — got: ${tokens.join(" ")}`,
      ).toBe(false);
    }
  });
});
