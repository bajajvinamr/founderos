// @vitest-environment node
//
// QuickWinsWidget (BL-023 / P8.c) — pure suggestion-builder tests.
//
// The widget reads `integrationsApi.list` via react-query and renders shadcn
// Cards; render-level tests require a QueryClient + Router harness. We export
// the pure `buildQuickWinSuggestions` builder and unit-test the prioritisation
// + padding behaviour — that's where the logic lives.

import { describe, expect, it } from "vitest";
import type { Integration, IntegrationKind } from "@founderos/shared";
import { buildQuickWinSuggestions } from "./QuickWinsWidget";

function makeIntegration(
  kind: IntegrationKind,
  status: Integration["status"] = "connected",
): Integration {
  return {
    id: `int-${kind}`,
    companyId: "co-1",
    kind,
    status,
    keyHint: null,
    config: null,
    lastError: null,
    connectedAt: status === "connected" ? new Date("2026-05-01T00:00:00Z") : null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  };
}

describe("buildQuickWinSuggestions", () => {
  it("returns at least 3 suggestions even with no integrations", () => {
    const suggestions = buildQuickWinSuggestions([]);
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it("returns at most 5 suggestions", () => {
    const suggestions = buildQuickWinSuggestions([]);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("handles undefined input (initial query state)", () => {
    const suggestions = buildQuickWinSuggestions(undefined);
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("each suggestion has a stable id and a non-empty title", () => {
    const suggestions = buildQuickWinSuggestions([]);
    for (const s of suggestions) {
      expect(s.id).toBeTruthy();
      expect(s.title.length).toBeGreaterThan(0);
    }
  });

  it("emits unique suggestion ids (React-key safety)", () => {
    const suggestions = buildQuickWinSuggestions([
      makeIntegration("stripe"),
      makeIntegration("posthog"),
      makeIntegration("slack"),
    ]);
    const ids = suggestions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prioritises suggestions tied to connected integrations", () => {
    // Only PostHog connected — the posthog-tagged suggestion should appear
    // before any fallback or non-connected suggestion.
    const suggestions = buildQuickWinSuggestions([makeIntegration("posthog")]);
    expect(suggestions[0]?.integration).toBe("posthog");
  });

  it("does NOT prioritise an integration that is present but not connected", () => {
    // Stripe row exists but status=error → it should not get top billing.
    const suggestions = buildQuickWinSuggestions([
      makeIntegration("stripe", "error"),
      makeIntegration("hubspot", "connected"),
    ]);
    expect(suggestions[0]?.integration).toBe("hubspot");
  });

  it("returns founder-language titles (no jargon, no metric IDs)", () => {
    // Sanity-check: nothing in the catalog should contain raw "API",
    // "integration", "KPI", or "metric" — those signal a leaky abstraction.
    const suggestions = buildQuickWinSuggestions([]);
    for (const s of suggestions) {
      expect(s.title).not.toMatch(/\b(API|KPI|metric|integration)\b/i);
    }
  });

  it("ranks multiple connected integrations above unconnected ones", () => {
    const suggestions = buildQuickWinSuggestions([
      makeIntegration("stripe"),
      makeIntegration("slack"),
    ]);
    // First two should be the connected ones.
    const top2 = suggestions.slice(0, 2).map((s) => s.integration);
    expect(top2).toContain("stripe");
    expect(top2).toContain("slack");
  });
});
