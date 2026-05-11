// @vitest-environment node
//
// YesterdayWidget (BL-022 / P8.b) — pure renderer tests.
//
// The widget reads `dashboardApi.yesterdaySummary` via react-query and renders
// shadcn-style sections. Render-level tests would require a QueryClient
// harness; we export the pure `renderOutcome` projector and unit-test it.
// The other widget tests in this directory (QuickWins, TopBlockers) follow
// the same pattern.

import { describe, expect, it } from "vitest";
import { renderOutcome } from "./YesterdayWidget";
import type { YesterdayOutcome } from "../../api/dashboard";

function makeOutcome(overrides: Partial<YesterdayOutcome> = {}): YesterdayOutcome {
  return {
    id: "iss-1",
    title: "Made job retries reliable",
    description: "Fewer manual reruns.",
    ...overrides,
  };
}

describe("renderOutcome", () => {
  it("passes through a well-formed outcome verbatim", () => {
    const out = makeOutcome();
    const view = renderOutcome(out);
    expect(view).toEqual({
      id: "iss-1",
      title: "Made job retries reliable",
      description: "Fewer manual reruns.",
    });
  });

  it("supplies a fallback title when the source title is empty/whitespace", () => {
    const view = renderOutcome(makeOutcome({ title: "   " }));
    expect(view.title).toBe("Untitled completion");
  });

  it("trims description whitespace", () => {
    const view = renderOutcome(makeOutcome({ description: "  trimmed  " }));
    expect(view.description).toBe("trimmed");
  });

  it("emits empty description string when Haiku gave nothing", () => {
    const view = renderOutcome(makeOutcome({ description: "" }));
    expect(view.description).toBe("");
  });

  it("preserves the source id verbatim — drives stable React keys", () => {
    const view = renderOutcome(makeOutcome({ id: "iss-abc-123" }));
    expect(view.id).toBe("iss-abc-123");
  });

  it("does not invent or mutate id when missing — caller guarantees presence", () => {
    // Defensive: an empty id from the server would be a contract violation,
    // but the projector should still return whatever it was given (test
    // documents the boundary).
    const view = renderOutcome(makeOutcome({ id: "" }));
    expect(view.id).toBe("");
  });
});
