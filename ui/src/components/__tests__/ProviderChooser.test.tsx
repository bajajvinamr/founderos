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

  it("registry exposes 6 live options with no coming-soon entries", () => {
    const live = PROVIDER_OPTIONS.filter((o) => o.status === "live");
    const comingSoon = PROVIDER_OPTIONS.filter(
      (o) => o.status === "coming-soon",
    );
    expect(live).toHaveLength(6);
    expect(live.map((o) => o.id)).toEqual([
      "claude_code",
      "anthropic_api",
      "gemini_cli",
      "google_api",
      "codex_cli",
      "openai_api",
    ]);
    expect(comingSoon).toHaveLength(0);
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

  it("all tiles are now selectable (no disabled tiles)", () => {
    const handleSelect = vi.fn();
    render({ onSelect: handleSelect });
    // All 6 tiles should be selectable — no coming-soon tiles
    const tiles = container.querySelectorAll(
      '[data-testid^="provider-tile-"]',
    ) as NodeListOf<HTMLButtonElement>;
    for (const tile of tiles) {
      expect(tile.getAttribute("aria-disabled")).toBeNull();
    }
  });

  it("all live tiles are tab-reachable (tabIndex=0 or absent)", () => {
    render();
    const liveIds = PROVIDER_OPTIONS.filter((o) => o.status === "live").map(
      (o) => o.id,
    );
    for (const id of liveIds) {
      const tile = container.querySelector(
        `[data-testid="provider-tile-${id}"]`,
      ) as HTMLButtonElement;
      const tabIndex = tile.getAttribute("tabindex");
      expect(tabIndex === null || tabIndex === "0").toBe(true);
    }
  });


  it("all 6 tiles are tab-reachable (no disabled skips)", () => {
    // Sequential tab traversal now lands on all tiles.
    render();
    const tiles = Array.from(
      container.querySelectorAll('[data-testid^="provider-tile-"]'),
    ) as HTMLButtonElement[];
    const tabReachable = tiles.filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
    expect(tabReachable).toHaveLength(6);
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

  it("all tiles now have no disabled tooltips", () => {
    // All tiles are live, so no coming-soon tooltips.
    render();
    const tiles = container.querySelectorAll(
      '[data-testid^="provider-tile-"]',
    ) as NodeListOf<HTMLButtonElement>;
    for (const tile of tiles) {
      // Live tiles have no title attribute (no tooltip needed)
      expect(tile.getAttribute("title")).toBeNull();
    }
  });

  it("no coming-soon badges are rendered (all tiles are live)", () => {
    render();
    const badges = container.querySelectorAll(
      '[data-testid="provider-badge-coming-soon"]',
    );
    expect(badges).toHaveLength(0);
  });

  it("subscription vs api-key badges render on all 6 live tiles", () => {
    render();
    const subscriptionBadges = container.querySelectorAll(
      '[data-testid="provider-badge-subscription"]',
    );
    const apiKeyBadges = container.querySelectorAll(
      '[data-testid="provider-badge-api-key"]',
    );
    // All 6 live tiles now carry auth-mode badges: 3 subscription + 3 api-key.
    expect(subscriptionBadges).toHaveLength(3);
    expect(apiKeyBadges).toHaveLength(3);
  });

  // Audit P0.4 — every tile (live AND coming-soon) must surface a
  // plain-English "what this requires" line so the founder knows what
  // they're signing up for before they pick.
  it("every tile renders a non-empty requirement sub-text", () => {
    render();
    for (const option of PROVIDER_OPTIONS) {
      const requirement = container.querySelector(
        `[data-testid="provider-requirement-${option.id}"]`,
      );
      expect(requirement).toBeTruthy();
      expect(requirement?.textContent ?? "").toBe(option.requirement);
      expect(option.requirement.length).toBeGreaterThan(0);
    }
  });

  // Audit P0.4 — the registry itself must enforce that every option
  // declares a `requirement` string. Catches future tiles added without
  // this honesty signal.
  it("every registry entry declares a requirement string", () => {
    for (const option of PROVIDER_OPTIONS) {
      expect(typeof option.requirement).toBe("string");
      expect(option.requirement.trim().length).toBeGreaterThan(0);
      // Sanity: must look like a sentence (ends with a period).
      expect(option.requirement.trim().endsWith(".")).toBe(true);
    }
  });

  // Audit P0.4 — clicking any live tile invokes onSelect.
  // Phase D unblocked all 6 tiles, so this test now verifies that all
  // tiles are selectable (no coming-soon gating).
  it("all 6 live tiles invoke onSelect when clicked", () => {
    const handleSelect = vi.fn();
    render({ onSelect: handleSelect });
    const allOptions = PROVIDER_OPTIONS.filter((o) => o.status === "live");
    expect(allOptions).toHaveLength(6);
    for (const option of allOptions) {
      const tile = container.querySelector(
        `[data-testid="provider-tile-${option.id}"]`,
      ) as HTMLButtonElement;
      act(() => tile.click());
    }
    expect(handleSelect).toHaveBeenCalledTimes(6);
  });
});
