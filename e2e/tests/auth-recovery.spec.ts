/**
 * Wave 23A — Auth recovery surface smoke test (Council P2, 2026-05-19).
 *
 * Closes the council finding that `auth-round-trip.spec.ts:43` references
 * forgot/reset coverage that didn't exist as a separate spec. This file is
 * that separate spec. It does NOT test the full email-delivery loop (that
 * would require Supabase email infra + IMAP poll + flaky in CI). Instead it
 * locks the recovery SURFACES in place — if a future redesign moves the
 * forgot-password flow behind a modal, or removes the reset-token error
 * state, this spec breaks and forces a contract update.
 *
 * Test inventory:
 *   (1) /auth/forgot renders the expected form (h1, email input, submit btn)
 *   (2) /auth/forgot — submitting a non-existent email reaches a TERMINAL
 *       state. Two valid terminal contracts depending on env:
 *         - Supabase reachable (prod, deployed previews) → "Check your email"
 *         - Supabase unreachable (CI's local_trusted mode, dev offline) →
 *           "Failed to fetch" / "network error" / "something went wrong"
 *       Load-bearing: confirms the UI state machine never hangs in pending.
 *       OR-match keeps the contract green across environments without
 *       requiring CI to talk to Supabase.
 *   (3) /auth/reset (no token) renders the "expired or invalid" error state
 *       — proves the page handles the no-session path gracefully instead of
 *       crashing or silently letting the user submit a new password without
 *       a recovery session
 *   (4) /auth/forgot → /auth back-link round-trips correctly (UX backstop —
 *       user can always get back to sign-in)
 *
 * What this spec does NOT do:
 *   - Send a real recovery email (would burn deliverability credit + flake)
 *   - Consume a real recovery token (requires email infra in CI)
 *   - Test the actual password update via updateUser (covered separately
 *     when canary infra is set up — see docs/runbooks/auth-canary.md)
 *
 * Prod-safe: no signup, no real email sent (Supabase silently no-ops on
 * non-existent emails to prevent enumeration), no auth state mutation.
 */
import { expect, test } from "../fixtures";

test.describe("[auth-recovery] forgot + reset surface smoke", () => {
  test("[auth-recovery] /auth/forgot renders the form correctly", async ({
    page,
  }) => {
    await page.goto("/auth/forgot");

    // H1 — semantic landmark for screen readers + assertion target. If a
    // redesign changes the heading text, update both the page and this
    // assertion so the contract stays explicit.
    await expect(page.getByRole("heading", { name: /forgot your password/i })).toBeVisible({
      timeout: 10_000,
    });

    // Email input + submit button — the two interactive elements the user
    // must see to complete the flow. Use role-based selectors over CSS
    // selectors so the assertions survive class refactors.
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /send reset link/i })).toBeVisible({
      timeout: 5_000,
    });

    // Back-to-sign-in escape hatch must be present.
    await expect(page.getByRole("link", { name: /back to sign in/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("[auth-recovery] submitting a non-existent email reaches a terminal UI state (success or network error)", async ({
    page,
  }) => {
    await page.goto("/auth/forgot");

    // Use a deterministic non-existent email so we don't accidentally
    // generate recovery email noise for a real user. Supabase silently
    // no-ops on non-existent emails (to prevent enumeration).
    const SAFE_EMAIL = `no-such-user-${Date.now()}@e2e-test.invalid`;
    await page.locator('input[type="email"]').fill(SAFE_EMAIL);
    await page.getByRole("button", { name: /send reset link/i }).click();

    // The form's state machine must reach a TERMINAL state — never hang in
    // pending. Two valid terminal states depending on env:
    //   (1) Supabase reachable (prod, deployed-preview) → "Check your email"
    //       success state. Supabase no-ops on non-existent emails to prevent
    //       enumeration, so success surfaces either way.
    //   (2) Supabase unreachable (CI's local_trusted mode, dev offline) →
    //       a network-error message like "Failed to fetch" or "network
    //       error". This is the correct UI behavior, not a bug.
    // The OR-match locks the state-machine contract regardless of network.
    await expect(
      page.getByText(/check your email|failed to fetch|network error|something went wrong/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("[auth-recovery] /auth/reset without a recovery session shows the expired/invalid error", async ({
    page,
  }) => {
    await page.goto("/auth/reset");

    // No recovery token in URL hash → supabase.auth.getSession() returns
    // null → the page renders the error state. This is the load-bearing
    // guard against a user submitting a new password without an active
    // recovery session (which would either silently fail at supabase or,
    // worse, update some unrelated session). The error message also tells
    // the user where to go to recover from the recovery flow.
    await expect(page.getByText(/reset link has expired or is invalid/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("[auth-recovery] /auth/forgot back-link returns to /auth", async ({ page }) => {
    await page.goto("/auth/forgot");
    await page.getByRole("link", { name: /back to sign in/i }).click();
    await expect(page).toHaveURL(/\/auth(\?.*)?$/, { timeout: 10_000 });
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
  });
});
