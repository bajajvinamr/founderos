/**
 * Shared helpers for client-readiness E2E specs.
 *
 * Each spec in this directory follows a two-tier shape:
 *
 *  1. "Server-alive smoke" — always runs. Validates that the FounderOS
 *     server is responding to /api/health. We do NOT guess specific
 *     tenant-scoped route paths from outside the auth boundary —
 *     workflows live at `/api/companies/:companyId/workflows`,
 *     onboarding-draft requires an authed user, etc. Probing those
 *     unauthed produces noise (404 / 401 / 403 ambiguity) that hides
 *     real regressions. The server-alive smoke is the right honest
 *     boundary for a public-only profile.
 *
 *  2. "Deep happy path" — runs only when its required fixtures are
 *     present (env vars listing test API keys, sandbox accounts, opt-ins).
 *     If any fixture is missing, the test calls `test.skip(true,
 *     "fixture-needed: <name> — <hint>")` so the gate stays green and
 *     the missing-fixture inventory is human-auditable from the
 *     Playwright report.
 *
 * Why this shape: the Day 6 LRP gate must be green to proceed to Day 7,
 * but several fixtures (Resend test-inbox API, Stripe signed-webhook
 * fixtures, runner-token TTL clock manipulation) are not yet wired.
 * Faking deep tests without their fixtures would hide real coverage gaps.
 * Skipping with a precise "what's needed" string surfaces the work
 * without blocking the gate.
 */

export function fixtureMissing(name: string, hint: string): string {
  return `fixture-needed: ${name} — ${hint}`;
}

export interface FixtureGate {
  ok: boolean;
  reason?: string;
}

/** Standard env-var fixture gate. */
export function envFixture(varName: string, hint: string): FixtureGate {
  const value = process.env[varName];
  if (!value || value.trim().length === 0) {
    return { ok: false, reason: fixtureMissing(varName, hint) };
  }
  return { ok: true };
}
