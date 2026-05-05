// @vitest-environment jsdom

/**
 * Council 2026-05-05 P2 (TC-2). Renders the connect-analytics prompt that
 * the GrowthConsole shows for paid users instead of mock data.
 *
 * The prompt is a load-bearing UX surface for the trust-gate fix:
 *   - Must list the three analytics connectors the council called out
 *     (Stripe / PostHog / LinkedIn).
 *   - Must NOT contain any of the demo numbers (e.g. "$10M", "+8%", "32%").
 *   - Must surface a CTA that routes to /integrations.
 *
 * Surface variants ("experiments" / "channels" / "funnel" / "paid") get
 * different headlines but the same connector list and CTA.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsConnectPrompt } from "./AnalyticsConnectPrompt";

// useNavigate is the only external dependency. Hoist a captured-call mock.
const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateSpy,
}));

// Required so React 19's `act` does not warn — see IssueChatThread.test.tsx.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigateSpy.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("AnalyticsConnectPrompt", () => {
  it("renders the three analytics connectors (Stripe, PostHog, LinkedIn)", () => {
    act(() => {
      root.render(<AnalyticsConnectPrompt surface="channels" />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Stripe");
    expect(text).toContain("PostHog");
    expect(text).toContain("LinkedIn");
  });

  it("does not contain any sample / demo numbers from the deleted MOCK_* constants", () => {
    // Defensive — if a future refactor accidentally re-adds demo values to
    // the prompt, this test catches it before it ships.
    act(() => {
      root.render(<AnalyticsConnectPrompt surface="experiments" />);
    });

    const text = container.textContent ?? "";
    // Specific demo strings from the previous MOCK_EXPERIMENTS / MOCK_FUNNEL.
    expect(text).not.toContain("$10M");
    expect(text).not.toContain("12,400"); // pageviews demo number
    expect(text).not.toContain("12400");
    expect(text).not.toContain("+8% signup");
    // Generic "32%" is too risky to assert (might appear in unrelated copy
    // someday); but the experimentally-fabricated demo CAC delta is unique.
    expect(text).not.toContain("-$18 CAC");
  });

  it("renders distinct headlines per surface", () => {
    const surfaces = ["experiments", "channels", "funnel", "paid"] as const;
    const headlines = new Set<string>();
    for (const surface of surfaces) {
      act(() => {
        root.render(<AnalyticsConnectPrompt surface={surface} />);
      });
      const h2 = container.querySelector("h2");
      expect(h2?.textContent).toBeTruthy();
      headlines.add(h2!.textContent!);
    }
    expect(headlines.size).toBe(surfaces.length);
  });

  it("CTA navigates to /integrations on click", () => {
    act(() => {
      root.render(<AnalyticsConnectPrompt surface="funnel" />);
    });

    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Connect"));
    expect(button).toBeTruthy();

    act(() => {
      button!.click();
    });
    expect(navigateSpy).toHaveBeenCalledWith("/integrations");
  });

  it("test-id hook is present so the GrowthConsole tests can assert this empty state", () => {
    act(() => {
      root.render(<AnalyticsConnectPrompt surface="paid" />);
    });
    expect(
      container.querySelector('[data-testid="analytics-connect-prompt"]'),
    ).toBeTruthy();
  });
});
