// @vitest-environment jsdom

/**
 * BL-002 (P2.a, founder-language sweep) — Step 4 H1 + subtitle copy.
 *
 * The wizard's Step 4 used to hardcode engineer-language strings ("Plug in
 * your brain" / "How should agents authenticate with Claude?"). After P2.a
 * it consumes `onboarding.step4.headline` and `onboarding.step4.subtitle`
 * via the DisplayDictionary so the copy switches based on the founder /
 * engineer viewMode stored in `founderos.viewMode`.
 *
 * The full FounderOnboardingWizard component depends on DialogContext,
 * CompanyContext, react-query, and the router — heavier than this audit
 * needs. We test the same observable contract the wizard wires up: the
 * `useDisplay` hook returns the right copy per mode, and the snapshot of
 * the rendered headline/subtitle pair reflects it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDisplay } from "@/lib/use-display";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "founderos.viewMode";

/**
 * Minimal Step 4 header shell — renders only the H1 + subtitle the wizard
 * shows at the top of Step 4. Mirrors the exact JSX so the snapshot is
 * meaningful but doesn't require the wizard's heavy context graph.
 */
function Step4HeaderShell() {
  const headline = useDisplay("onboarding.step4.headline");
  const subtitle = useDisplay("onboarding.step4.subtitle");
  return (
    <div>
      <h2
        className="text-2xl font-semibold tracking-tight"
        data-testid="onboarding-step4-headline"
      >
        {headline}
      </h2>
      <p
        className="mt-2 text-sm text-muted-foreground"
        data-testid="onboarding-step4-subtitle"
      >
        {subtitle}
      </p>
    </div>
  );
}

describe("BL-002: Step 4 founder-language copy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("renders founder copy by default (no viewMode set)", () => {
    act(() => {
      root.render(<Step4HeaderShell />);
    });

    const headline = container.querySelector(
      '[data-testid="onboarding-step4-headline"]',
    );
    const subtitle = container.querySelector(
      '[data-testid="onboarding-step4-subtitle"]',
    );
    expect(headline?.textContent).toBe("How should FounderOS use AI?");
    expect(subtitle?.textContent).toBe(
      "Pick where the AI for your team should run",
    );
  });

  it("renders founder copy when viewMode=founder", () => {
    window.localStorage.setItem(STORAGE_KEY, "founder");
    act(() => {
      root.render(<Step4HeaderShell />);
    });

    const headline = container.querySelector(
      '[data-testid="onboarding-step4-headline"]',
    );
    const subtitle = container.querySelector(
      '[data-testid="onboarding-step4-subtitle"]',
    );
    expect(headline?.textContent).toBe("How should FounderOS use AI?");
    expect(subtitle?.textContent).toBe(
      "Pick where the AI for your team should run",
    );
  });

  it("renders engineer copy when viewMode=engineer", () => {
    window.localStorage.setItem(STORAGE_KEY, "engineer");
    act(() => {
      root.render(<Step4HeaderShell />);
    });

    const headline = container.querySelector(
      '[data-testid="onboarding-step4-headline"]',
    );
    const subtitle = container.querySelector(
      '[data-testid="onboarding-step4-subtitle"]',
    );
    expect(headline?.textContent).toBe("Adapter configuration");
    expect(subtitle?.textContent).toBe(
      "Select adapter family + provider",
    );
  });

  it("does NOT render the pre-P2.a engineer-jargon strings in either mode", () => {
    // Regression guard — the strings that BL-002 replaces. If either mode
    // ever renders the old copy, P2.a has regressed.
    for (const mode of ["founder", "engineer"] as const) {
      window.localStorage.setItem(STORAGE_KEY, mode);
      act(() => {
        root.render(<Step4HeaderShell />);
      });
      expect(container.textContent).not.toContain("Plug in your brain");
      expect(container.textContent).not.toContain(
        "How should agents authenticate with Claude?",
      );
    }
  });
});
