/**
 * FounderOS end-to-end smoke test — full happy path
 *
 * Covers: landing → sign-up → onboarding wizard → Dashboard renders.
 *
 * Prerequisites:
 *   - Server running in `authenticated` mode on :3100 (default) or $BASE_URL.
 *   - better-auth email-password provider enabled.
 *
 * Run locally:
 *   pnpm test:smoke
 *
 * If the server is in `local_trusted` mode (no /auth page), the test skips
 * with a clear message so CI doesn't red on a dev-only config.
 */

import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SMOKE_EMAIL = `test-${Date.now()}@founderos-smoke.local`;
const SMOKE_PASSWORD = "Smoke123!";
const SMOKE_NAME = "Smoke Tester";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check /api/auth/config to determine whether the instance requires auth.
 * Returns false when the server is in local_trusted mode.
 */
async function requiresAuth(page: Page): Promise<boolean> {
  const res = await page.request.get("/api/auth/config");
  if (!res.ok()) {
    // Can't determine mode — assume authenticated.
    return true;
  }
  const body = (await res.json()) as { deploymentMode?: string };
  return body.deploymentMode !== "local_trusted";
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

test.describe("Smoke: landing → sign-up → onboarding → dashboard", () => {
  test("full happy path", async ({ page }) => {
    // ── Guard: skip on local_trusted mode ──────────────────────────────────
    const needsAuth = await requiresAuth(page);
    if (!needsAuth) {
      test.skip(true, "server running in local_trusted mode — sign-up flow unavailable");
      return;
    }

    // ── Step 1: Landing page ───────────────────────────────────────────────
    await page.goto("/landing", { waitUntil: "domcontentloaded" });

    // The hero H1 reads: "Build a $10M company with 3 people."
    // It's split across inline spans, so we match the full text on the h1.
    const heroH1 = page.locator("h1").first();
    await expect(heroH1).toBeVisible({ timeout: 10_000 });
    await expect(heroH1).toContainText("$10M", { ignoreCase: false });
    await expect(heroH1).toContainText("3 people", { ignoreCase: false });

    // ── Step 2: Click primary CTA → /auth ─────────────────────────────────
    // The nav bar has a "Build your company" .btn link pointing to /auth.
    // Use the first visible one (desktop nav).
    const ctaLink = page.locator("a.btn", { hasText: "Build your company" }).first();
    await expect(ctaLink).toBeVisible({ timeout: 5_000 });
    await ctaLink.click();

    await expect(page).toHaveURL(/\/auth/, { timeout: 10_000 });

    // ── Step 3: Switch to sign-up mode ────────────────────────────────────
    // The auth page starts in sign_in mode. Click "Create one" to flip.
    const createOneBtn = page.getByRole("button", { name: "Create one" });
    await expect(createOneBtn).toBeVisible({ timeout: 5_000 });
    await createOneBtn.click();

    // Confirm we're in sign-up mode — the Name field appears.
    const nameInput = page.locator("#name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    // ── Step 4: Fill sign-up form ─────────────────────────────────────────
    await nameInput.fill(SMOKE_NAME);
    await page.locator("#email").fill(SMOKE_EMAIL);
    await page.locator("#password").fill(SMOKE_PASSWORD);

    // ── Step 5: Submit ────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Create Account" }).click();

    // ── Step 6: Wait for onboarding or dashboard ──────────────────────────
    await expect(page).toHaveURL(/\/(onboarding|dashboard)/, { timeout: 15_000 });

    const url = page.url();

    if (url.includes("/dashboard")) {
      // App skipped onboarding (e.g. admin auto-create). Just verify dashboard.
      await verifyDashboard(page);
      return;
    }

    // ── Step 7: Onboarding wizard ─────────────────────────────────────────
    // Step 1/4 — Welcome: "Build a company. Staff it with AI."
    // The CTA is a Button with text "Start setup".
    const startSetupBtn = page.getByRole("button", { name: "Start setup" });
    await expect(startSetupBtn).toBeVisible({ timeout: 10_000 });
    await startSetupBtn.click();

    // Step 2/4 — Template picker
    // Wait for at least one template card to appear (role=button inside the grid).
    const firstTemplateCard = page
      .locator("button[type='button']")
      .filter({ hasText: /CEO|Founder|startup/i })
      .first();
    await expect(firstTemplateCard).toBeVisible({ timeout: 10_000 });
    await firstTemplateCard.click();

    // Clicking a template card auto-advances to the providers step.
    // We stub /api/providers to return anyConfigured: true so we can proceed
    // without real keys. This is done via route interception.
    await page.route("**/api/providers**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [
            {
              family: "anthropic",
              api: { configured: true, keyHint: "sk-ant-****" },
              cli: { installed: false },
            },
            {
              family: "openai",
              api: { configured: false },
              cli: { installed: false },
            },
            {
              family: "google",
              api: { configured: false },
              cli: { installed: false },
            },
          ],
          availability: { anyConfigured: true },
          storedKeys: [{ family: "anthropic", executionMode: "api", keyHint: "sk-ant-****" }],
        }),
      });
    });

    // Step 3/4 — Providers: the "Continue" button should be enabled now.
    const continueBtn = page.getByRole("button", { name: "Continue" });
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await expect(continueBtn).toBeEnabled({ timeout: 8_000 });
    await continueBtn.click();

    // Step 4/4 — Review: fill company name if empty, then click Launch.
    const companyNameInput = page.locator("#company-name");
    await expect(companyNameInput).toBeVisible({ timeout: 8_000 });

    // Pre-filled from template name; add a smoke suffix to make it unique.
    const existingName = await companyNameInput.inputValue();
    if (!existingName.trim()) {
      await companyNameInput.fill("Smoke Co");
    } else {
      await companyNameInput.fill(`${existingName} Smoke`);
    }

    // Launch button: "Launch <company name> →"
    const launchBtn = page.getByRole("button", { name: /Launch/i });
    await expect(launchBtn).toBeEnabled({ timeout: 5_000 });
    await launchBtn.click();

    // ── Step 8: Wait for /dashboard ───────────────────────────────────────
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    // ── Step 9: Verify dashboard renders ─────────────────────────────────
    await verifyDashboard(page);
  });
});

// ---------------------------------------------------------------------------
// Dashboard assertions
// ---------------------------------------------------------------------------

/**
 * Assert that the Dashboard is rendered and the FounderBriefing "Morning brief"
 * eyebrow and a greeting heading are visible.
 */
async function verifyDashboard(page: Page): Promise<void> {
  // The FounderBriefing component renders an eyebrow div containing "Morning brief"
  // (formatted as "<date> · Morning brief").
  const morningBrief = page.locator("text=/morning brief/i").first();
  await expect(morningBrief).toBeVisible({ timeout: 10_000 });

  // The greeting is an h2 with "Good morning, …" / "Good afternoon, …" etc.
  // It's rendered as: `{greeting}{firstName ? `, ${firstName}` : ""}.`
  const greeting = page.locator("h2").filter({ hasText: /good (morning|afternoon|evening)/i }).first();
  await expect(greeting).toBeVisible({ timeout: 10_000 });
}
