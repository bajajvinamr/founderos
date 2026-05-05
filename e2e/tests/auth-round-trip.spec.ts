/**
 * Auth round-trip spec — env-gated, prod-safe canary.
 *
 * Proves the full Clerk/Supabase login → dashboard flow against the live
 * deployment. Mocked unit tests can prove the auth client *intends* to sign
 * in correctly, but only this spec proves the actual round-trip with the
 * Supabase project's real JWT pipeline.
 *
 * Used as the production auth canary: scheduled in
 * `.github/workflows/e2e-synthetic.yml` (every 15 min) and on every
 * post-deploy hook (`.github/workflows/deploy-prod.yml` →
 * `repository_dispatch`) to fail loud + page on-call when prod auth breaks.
 *
 * Env-gated to keep credentials out of the repo. Two interchangeable env
 * variable names supported (CANARY_USER_* preferred for new wiring,
 * FOUNDEROS_E2E_TEST_USER_* kept for backward-compat with existing local
 * dev workflows). CANARY_USER_* wins when both are present.
 *
 *   CANARY_USER_EMAIL=canary@founderos.dev \
 *   CANARY_USER_PASSWORD='REDACTED' \
 *   FOUNDEROS_E2E_BASE_URL=https://founderos.fly.dev \
 *     pnpm e2e -- --grep "auth-round-trip"
 *
 * Canary user contract — see docs/runbooks/auth-canary.md:
 *   - Pre-created Supabase user (email-confirmed, NOT a fresh signup).
 *   - At least one company assigned, so post-auth lands on /{PREFIX}/dashboard.
 *   - Password rotated quarterly (docs/runbooks/secret-rotation.md).
 *   - Tagged `is_canary=true` in `public."user".metadata` so we can exclude
 *     it from product analytics.
 *
 * What this spec proves:
 *   1. The /auth page renders the email/password form (post-PR #18 Clerk
 *      override didn't break the form).
 *   2. signInWithPassword reaches the right Supabase project and returns a
 *      session within 10s.
 *   3. After sign-in, the user lands on a board page (/{prefix}/dashboard).
 *   4. The board page issues at least one authenticated /api/companies call
 *      that returns 200 (proving the bearer token round-trips and the
 *      authenticated mode authz logic accepts the JWT).
 *
 * What this spec does NOT do:
 *   - Sign up a new user (would mutate prod). Uses a pre-created canary.
 *   - Test password reset (separate spec; covered by /auth/forgot, /auth/reset).
 *   - Test OAuth (different flow, different cred handling).
 */
import { expect, test } from "../fixtures";

// CANARY_USER_* is the canonical name (used by GitHub Actions + Fly secrets).
// FOUNDEROS_E2E_TEST_USER_* kept as a fallback for local dev that already had
// it set. CANARY_USER_* wins when both are present.
const TEST_EMAIL =
  process.env.CANARY_USER_EMAIL?.trim() ||
  process.env.FOUNDEROS_E2E_TEST_USER_EMAIL?.trim() ||
  "";
const TEST_PASSWORD =
  process.env.CANARY_USER_PASSWORD ||
  process.env.FOUNDEROS_E2E_TEST_USER_PASSWORD ||
  "";
const HAVE_CREDS = TEST_EMAIL.length > 0 && TEST_PASSWORD.length > 0;

test.describe("[auth-round-trip] sign-in flow against live Supabase", () => {
  test.skip(
    !HAVE_CREDS,
    "CANARY_USER_EMAIL + CANARY_USER_PASSWORD (or FOUNDEROS_E2E_TEST_USER_*) must be set — see docs/runbooks/auth-canary.md",
  );

  test("[auth-round-trip] /auth renders the email + password form", async ({
    page,
  }) => {
    await page.goto("/auth");
    // The Auth page renders an <input type="email"> + <input type="password">
    // pair. We assert both are present + visible. If a future redesign moves
    // email to a multi-step flow, this assertion becomes the reminder to
    // update both the spec and the form contract.
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 5_000 });
  });

  test("[auth-round-trip] sign-in lands the user on a board with a valid session", async ({
    page,
  }) => {
    await page.goto("/auth");
    await page.locator('input[type="email"]').fill(TEST_EMAIL);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);

    // Capture the /api/companies call that fires immediately after auth —
    // this is the load-bearing proof that the bearer token round-trips.
    const companiesPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/companies") && resp.request().method() === "GET",
      { timeout: 20_000 },
    );

    // Click the primary submit button (form-scoped, avoids matching nav).
    await page.locator('form button[type="submit"]').first().click();

    // Wait for the post-auth redirect. CompanyRootRedirect routes to
    // /{prefix}/dashboard. Match either pattern + a 200 on /api/companies.
    const companiesResp = await companiesPromise;
    expect(
      companiesResp.status(),
      "/api/companies after sign-in should return 200",
    ).toBe(200);

    // After ~1s the redirect should have settled. Verify the URL.
    await page.waitForURL(/\/[A-Z]{3,}\/dashboard/, { timeout: 15_000 });

    // And the page should NOT show the "Select a company" empty state — a
    // signed-in user with at least one company should land on a real board.
    await expect(
      page.locator("text=/Select a company/i"),
      "user with companies should not see Select-a-company empty state",
    ).toHaveCount(0);
  });
});
