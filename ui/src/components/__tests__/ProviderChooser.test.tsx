// @vitest-environment jsdom

/**
 * S7.C.1 — ProviderChooser unit tests.
 *
 * Acceptance per the phase doc:
 *   - 6 tiles render
 *   - clicking a live tile calls onSelect with the option
 *   - clicking a disabled tile is a no-op
 *   - disabled tiles carry aria-disabled="true"
 *   - tab nav skips disabled tiles (tabIndex={-1})
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROVIDER_OPTIONS,
  ProviderChooser,
  type ProviderOption,
} from "../onboarding/ProviderChooser";

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProviderChooser", () => {
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
  });

  function render(props: {
    selectedId?: string | null;
    onSelect?: (option: ProviderOption) => void;
  } = {}) {
    const onSelect = props.onSelect ?? (() => {});
    act(() => {
      root.render(
        <ProviderChooser
          selectedId={props.selectedId ?? null}
          onSelect={onSelect}
        />,
      );
    });
  }

  it("renders all 6 tiles in registry order", () => {
    render();
    const tiles = container.querySelectorAll('[data-testid^="provider-tile-"]');
    expect(tiles).toHaveLength(6);
    const ids = Array.from(tiles).map((el) =>
      el.getAttribute("data-testid")?.replace("provider-tile-", ""),
    );
    expect(ids).toEqual([
      "claude_code",
      "anthropic_api",
      "gemini_cli",
      "google_api",
      "codex_cli",
      "openai_api",
    ]);
  });

  it("registry exposes 2 live + 4 coming-soon options", () => {
    const live = PROVIDER_OPTIONS.filter((o) => o.status === "live");
    const comingSoon = PROVIDER_OPTIONS.filter(
      (o) => o.status === "coming-soon",
    );
    expect(live.map((o) => o.id)).toEqual(["claude_code", "anthropic_api"]);
    expect(comingSoon).toHaveLength(4);
    // Every coming-soon entry must carry an etaPhase tooltip target.
    for (const option of comingSoon) {
      expect(option.etaPhase).toMatch(/^S7\.B\.\d+$/);
    }
  });

  it("clicking a live tile fires onSelect with the option", () => {
    const handleSelect = vi.fn();
    render({ onSelect: handleSelect });
    const tile = container.querySelector(
      '[data-testid="provider-tile-claude_code"]',
    ) as HTMLButtonElement;
    expect(tile).toBeTruthy();
    act(() => tile.click());
    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect.mock.calls[0]?.[0]).toMatchObject({
      id: "claude_code",
      adapterType: "claude_local",
      authMode: "subscription",
      status: "live",
    });
  });

  it("clicking a disabled tile is a no-op", () => {
    const handleSelect = vi.fn();
    render({ onSelect: handleSelect });
    const disabled = container.querySelector(
      '[data-testid="provider-tile-gemini_cli"]',
    ) as HTMLButtonElement;
    expect(disabled).toBeTruthy();
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    act(() => disabled.click());
    expect(handleSelect).not.toHaveBeenCalled();
  });

  it("disabled tiles carry aria-disabled='true' and tabIndex=-1", () => {
    render();
    const comingSoonIds = PROVIDER_OPTIONS.filter(
      (o) => o.status === "coming-soon",
    ).map((o) => o.id);
    for (const id of comingSoonIds) {
      const tile = container.querySelector(
        `[data-testid="provider-tile-${id}"]`,
      ) as HTMLButtonElement;
      expect(tile.getAttribute("aria-disabled")).toBe("true");
      expect(tile.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("live tiles are tab-reachable (tabIndex=0)", () => {
    render();
    const liveIds = PROVIDER_OPTIONS.filter((o) => o.status === "live").map(
      (o) => o.id,
    );
    for (const id of liveIds) {
      const tile = container.querySelector(
        `[data-testid="provider-tile-${id}"]`,
      ) as HTMLButtonElement;
      expect(tile.getAttribute("aria-disabled")).toBeNull();
      // tabIndex={0} is the React default for a button — node attribute
      // may be absent OR explicitly "0", both accept tab focus.
      const tabIndex = tile.getAttribute("tabindex");
      expect(tabIndex === null || tabIndex === "0").toBe(true);
    }
  });

  it("tab nav order skips disabled tiles", () => {
    // Sequential tab traversal landing only on tabIndex>=0 elements.
    render();
    const tiles = Array.from(
      container.querySelectorAll('[data-testid^="provider-tile-"]'),
    ) as HTMLButtonElement[];
    const tabReachable = tiles.filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
    expect(tabReachable).toHaveLength(2);
    const reachableIds = tabReachable.map((el) =>
      el.getAttribute("data-testid")?.replace("provider-tile-", ""),
    );
    expect(reachableIds).toEqual(["claude_code", "anthropic_api"]);
  });

  it("renders the selection ring on the selected tile only", () => {
    render({ selectedId: "anthropic_api" });
    const selected = container.querySelector(
      '[data-testid="provider-tile-anthropic_api"]',
    ) as HTMLButtonElement;
    const unselected = container.querySelector(
      '[data-testid="provider-tile-claude_code"]',
    ) as HTMLButtonElement;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(unselected.getAttribute("aria-pressed")).toBe("false");
  });

  it("disabled tiles surface the etaPhase in the title tooltip", () => {
    render();
    for (const option of PROVIDER_OPTIONS) {
      if (option.status !== "coming-soon") continue;
      const tile = container.querySelector(
        `[data-testid="provider-tile-${option.id}"]`,
      ) as HTMLButtonElement;
      expect(tile.getAttribute("title")).toContain(option.etaPhase ?? "");
      expect(tile.getAttribute("title")).toContain(option.label);
    }
  });

  it("coming-soon tiles show the badge with the eta-phase copy", () => {
    render();
    const badges = container.querySelectorAll(
      '[data-testid="provider-badge-coming-soon"]',
    );
    expect(badges).toHaveLength(4);
    const labels = Array.from(badges).map((el) => el.textContent ?? "");
    // Each badge should mention "Coming Soon" and the S7.B.x ETA.
    for (const label of labels) {
      expect(label).toMatch(/Coming Soon\s*·\s*S7\.B\.\d+/);
    }
  });

  it("subscription vs api-key badges render only on live tiles", () => {
    render();
    const subscriptionBadges = container.querySelectorAll(
      '[data-testid="provider-badge-subscription"]',
    );
    const apiKeyBadges = container.querySelectorAll(
      '[data-testid="provider-badge-api-key"]',
    );
    // Only the two live tiles carry these badges.
    expect(subscriptionBadges).toHaveLength(1);
    expect(apiKeyBadges).toHaveLength(1);
  });
});
