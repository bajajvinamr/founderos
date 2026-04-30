/**
 * Wave 23A — Critical-flow E2E suite.
 *
 * Separate config from `tests/e2e/` (which owns onboarding/signoff specs with
 * their own webServer) so CI + synthetic monitoring can target this suite
 * independently without colliding with unrelated tests.
 *
 * Usage:
 *   pnpm e2e                               # default local (http://localhost:3100)
 *   FOUNDEROS_E2E_BASE_URL=https://founderos-bice.vercel.app pnpm e2e
 *   FOUNDEROS_E2E_PROFILE=public-only pnpm e2e   # skip auth-required specs
 *
 * Env vars:
 *   FOUNDEROS_E2E_BASE_URL     — target origin. Default http://localhost:3100.
 *   FOUNDEROS_E2E_PROFILE      — `default` (all) | `public-only` (synthetic).
 *   FOUNDEROS_E2E_DEMO_PREFIX  — company issuePrefix to use for scoped API
 *                                calls. Default AGN (agnost.ai from seed-demo).
 *   CI                         — when set, retries=2 and failures upload HTML.
 */
import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.FOUNDEROS_E2E_BASE_URL || "http://localhost:3100";
const IS_CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: IS_CI ? 2 : 1,
  // Keep it serial inside a file so rate-limit test doesn't race other API
  // calls on the same limiter key.
  fullyParallel: false,
  workers: IS_CI ? 2 : 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./playwright-report" }],
  ],
  outputDir: "./test-results",
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: IS_CI ? "retain-on-failure" : "on-first-retry",
    video: IS_CI ? "retain-on-failure" : "off",
    // Reasonable default for local + preview deploys; CI runners sometimes
    // need a little more headroom before the first paint.
    navigationTimeout: 20_000,
    actionTimeout: 10_000,
    // Send a stable UA so backend logs/heuristics can identify synthetic probes.
    // Must be ASCII-only: Playwright's APIRequestContext rejects non-ASCII chars
    // (e.g. the em dash U+2014) in HTTP header values.
    userAgent:
      "FounderOS-E2E/23A (+https://github.com/founderos/founderos - critical-flows)",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
