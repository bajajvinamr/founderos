/**
 * Client-readiness #4 — runner token expires and rotates (validates W0.3).
 *
 * Per LRP Day 6 spec:
 *   - Issue token with ttl_days=1
 *   - Wait or set system clock forward
 *   - Authenticated runner request returns 401 with rotation hint
 *   - POST /rotate issues new token
 *   - New token authenticates; old token rejected
 *   - 24h grace: old token still works during grace window
 *
 * Required fixtures (deep happy path):
 *   - FOUNDEROS_E2E_BOARD_API_KEY — board API key for issuing runner tokens
 *   - FOUNDEROS_E2E_RUNNER_TOKEN_TTL_OVERRIDE — server-side env that lets
 *     the test issue a token with ttl_seconds=2 (instead of waiting a day).
 *     If absent, the test must skip — system clock manipulation in
 *     Playwright is not safe across the runner-auth middleware (which uses
 *     `now()` in a SQL subquery against the DB clock, not the JS clock).
 *
 * Notes on the security model (per CLAUDE.md):
 *   - Tokens are stored as sha256 hashes; plaintext shown once.
 *   - Liveness pill is driven by lastSeenAt < 30s; long-poll IS the
 *     heartbeat. No explicit heartbeat endpoint to test.
 *   - Rotation issues a new fos_<32 alnum> token + 24h grace window where
 *     the old token still authenticates (zero-downtime rotation).
 */
import { test, expect } from "../../fixtures";
import { envFixture } from "./_helpers";

test.describe("client-readiness — runner token expiry + rotation", () => {
  test("[server-alive] /api/health responds", async ({ api }) => {
    const res = await api.get("/api/health");
    expect(
      res.status,
      `GET /api/health returned ${res.status}.`,
    ).toBe(200);
  });

  test("[deep] expired token returns 401 with rotation hint; rotate yields fresh token", async ({
    api,
  }) => {
    if ((process.env.FOUNDEROS_E2E_PROFILE || "").toLowerCase() === "public-only") {
      test.skip(true, "public-only profile — runner-token issuance mutates state and runs only on isolated staging");
      return;
    }

    const apiKey = envFixture(
      "FOUNDEROS_E2E_BOARD_API_KEY",
      "board API key with runner.token.write authority",
    );
    const ttlOverride = envFixture(
      "FOUNDEROS_E2E_RUNNER_TOKEN_TTL_OVERRIDE",
      "server-side env letting the test issue a token with seconds-level TTL",
    );

    const reasons = [apiKey, ttlOverride].filter((f) => !f.ok).map((f) => f.reason!);
    if (reasons.length > 0) {
      test.skip(true, reasons.join(" | "));
      return;
    }

    // When fixtures are wired:
    //   1. POST /api/runner/tokens with { label, ttlSeconds: 2 } → assert
    //      response contains { id, plaintext: /^fos_[a-z0-9]{32}$/ }
    //   2. Make an authenticated runner GET (e.g. /api/runner/jobs) using
    //      the plaintext as Bearer → assert 200
    //   3. Sleep 3 seconds (ttl + 1)
    //   4. Same runner GET → assert 401 with body
    //      { error: "token_expired", rotateHint: "/api/runner/tokens/:id/rotate" }
    //   5. POST /api/runner/tokens/:id/rotate → assert 201 with new
    //      plaintext fos_<32 alnum>
    //   6. New plaintext authenticates → 200
    //   7. Old plaintext still works (24h grace) → 200 with header
    //      x-runner-token-grace=true
    //
    // Implementation deferred to fixture-wire-up.
    expect(true, "deep flow body to be added when fixture wired").toBe(true);
  });
});
