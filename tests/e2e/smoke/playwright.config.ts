/**
 * Playwright config for the FounderOS auth-mode smoke suite.
 *
 * Prerequisites: server running in `authenticated` mode on :3100.
 *   pnpm founderos run   (or the normal `pnpm dev` stack)
 *
 * Usage:
 *   pnpm test:smoke
 *   BASE_URL=http://localhost:3100 pnpm test:smoke
 */
import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // No webServer block — smoke suite assumes server is already running.
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
