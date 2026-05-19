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
 *   (2) /auth/forgot — submitting a valid email shows the "Check your email"
 *       success state (load-bearing: confirms supabase.auth.resetPasswordForEmail
 *       wires correctly to the UI state machine; we use a known-non-existent
 *       email so no real account gets a recovery email)
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

  test("[auth-recovery] submitting a non-existent email shows the 'check your email' success state", async ({
    page,
  }) => {
    await page.goto("/auth/forgot");

    // Use a deterministic non-existent email so we don't accidentally
    // generate recovery email noise for a real user. Supabase silently
    // no-ops on non-existent emails (to prevent enumeration), which means
    // the UI shows the same success state either way — exactly what we
    // want to assert.
    const SAFE_EMAIL = `no-such-user-${Date.now()}@e2e-test.invalid`;
    await page.locator('input[type="email"]').fill(SAFE_EMAIL);
    await page.getByRole("button", { name: /send reset link/i }).click();

    // Success state: "Check your email" copy. If supabase.auth.reset-
    // PasswordForEmail throws (network down, rate-limited), the UI surfaces
    // an error and the success copy doesn't appear — this assertion catches
    // both that regression and a UI state-machine bug where pending never
    // resolves.
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 });

    // The success state echoes the email back for confirmation — important
    // UX detail to lock in (helps the user spot a typo before they wait for
    // a non-arriving email).
    await expect(page.getByText(SAFE_EMAIL)).toBeVisible({ timeout: 5_000 });
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
