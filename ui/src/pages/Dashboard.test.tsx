// @vitest-environment node
//
// BL-021 / P8.a regression test. Reads the Dashboard source and asserts that
// the four widgets removed for the dashboard-noise sweep have NOT been
// re-introduced. Source-level (not render-level) because a full Dashboard
// render requires CompanyContext, DialogContext, BreadcrumbContext,
// QueryClient, Router, ToastContext, and ~9 react-query fetches — out of
// proportion to the assertion. Source-level catches the regression that
// matters: someone re-pastes the widget back into Dashboard.tsx.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SOURCE = readFileSync(resolve(__dirname, "Dashboard.tsx"), "utf8");

describe("Dashboard (BL-021 / P8.a — dashboard noise cleared)", () => {
  it("does not render the RunActivityChart widget", () => {
    // Either the JSX tag form OR a `RunActivityChart` import would be a
    // regression. The component file at ../components/ActivityCharts.tsx is
    // preserved — it's still used elsewhere — but Dashboard must not import
    // it.
    expect(DASHBOARD_SOURCE).not.toMatch(/<RunActivityChart\b/);
    expect(DASHBOARD_SOURCE).not.toMatch(/\bRunActivityChart\b\s*(?=,|\s*})/);
  });

  it("does not render a raw cost / Month spend MetricCard", () => {
    // The Month-spend tile was a DollarSign + raw cents value above the fold.
    // Its absence is the BL-021 signal. We match the JSX-prop form
    // (label="Month spend") rather than the bare string, so an explanatory
    // comment that mentions "Month spend" doesn't trip the assertion.
    expect(DASHBOARD_SOURCE).not.toMatch(/label=["']Month spend["']/);
    expect(DASHBOARD_SOURCE).not.toMatch(/\bDollarSign\b/);
    expect(DASHBOARD_SOURCE).not.toMatch(/\bformatCents\b/);
  });

  it("does not render the Recent Activity feed", () => {
    // The visible feed (ActivityRow loop) was removed. The activityApi query
    // is intentionally kept — <FounderBriefing> consumes it for the
    // morning-brief narrative — so we test for the JSX usage, not the import
    // or query.
    expect(DASHBOARD_SOURCE).not.toMatch(/<ActivityRow\b/);
    expect(DASHBOARD_SOURCE).not.toMatch(/Recent Activity\s*<\/h3>/);
    // entityNameMap / entityTitleMap were ONLY used by the feed — their
    // re-appearance would signal a partial revert.
    expect(DASHBOARD_SOURCE).not.toMatch(/\bentityNameMap\b/);
    expect(DASHBOARD_SOURCE).not.toMatch(/\bentityTitleMap\b/);
  });

  it("does not render the PermissionCoachCard on the dashboard", () => {
    // Component file (../components/PermissionCoachCard.tsx) and its API
    // module are preserved for a follow-up relocation; the dashboard itself
    // must not mount the card.
    expect(DASHBOARD_SOURCE).not.toMatch(/<PermissionCoachCard\b/);
    // The PermissionCoachCard import was the only consumer in this file.
    // A re-introduced import is the leading regression signal.
    expect(DASHBOARD_SOURCE).not.toMatch(
      /from\s+["']\.\.\/components\/PermissionCoachCard["']/,
    );
  });

  it("keeps the FounderBriefing widget (P8.a is a removal sweep, not a rewrite)", () => {
    // Positive assertion so a future overzealous cleanup doesn't take out the
    // morning-brief widget along with the noise.
    expect(DASHBOARD_SOURCE).toMatch(/<FounderBriefing\b/);
  });

  it("keeps the activity query for FounderBriefing", () => {
    // activityApi.list feeds FounderBriefing's recentActivity computation.
    // The visible Recent Activity feed was removed, but the data fetch must
    // remain.
    expect(DASHBOARD_SOURCE).toMatch(/activityApi\.list/);
  });
});
