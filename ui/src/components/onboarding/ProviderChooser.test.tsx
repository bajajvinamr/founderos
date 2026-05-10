// @vitest-environment jsdom

/**
 * BL-004 (P2.c, audit finding) — adapter chooser starts with NO tile
 * pre-selected.
 *
 * Prior behaviour (pre-2026-05-11): the chooser defaulted to the
 * "Anthropic API" tile, which biased analytics ("most founders pick
 * Anthropic" — they didn't, the tile was just pre-selected).
 *
 * New behaviour: `selectedId` is null on first paint of Step 4, every
 * tile carries `aria-pressed="false"`, and the wizard's Continue button
 * stays disabled until the founder explicitly clicks a tile. This test
 * mirrors the `selectedId` derivation that `FounderOnboardingWizard.tsx`
 * uses on first paint (`mapAdapterToProviderId(null, ...) === null`).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderChooser } from "./ProviderChooser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<ProviderChooser /> default selection (BL-004)", () => {
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
  });

  it("renders with no tile pre-selected when selectedId is null", () => {
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    // Every live tile must show aria-pressed="false" on first paint — the
    // founder has not made a choice yet.
    const liveTileIds = [
      "claude_code",
      "anthropic_api",
      "gemini_cli",
      "google_api",
      "codex_cli",
      "openai_api",
    ];
    for (const id of liveTileIds) {
      const tile = container.querySelector(
        `[data-testid="provider-tile-${id}"]`,
      );
      expect(tile, `tile ${id} should render`).not.toBeNull();
      expect(
        tile?.getAttribute("aria-pressed"),
        `tile ${id} should not be pre-selected`,
      ).toBe("false");
    }
  });

  it("describes Claude Code as a developer-only path", () => {
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    // The chooser surface should communicate that Claude Code is for
    // developers — the prompt's "for developers — requires Claude Code
    // CLI installed on your laptop" copy.
    const text = container.textContent ?? "";
    expect(text).toContain("For developers");
    expect(text.toLowerCase()).toContain("claude code cli");
  });
});
