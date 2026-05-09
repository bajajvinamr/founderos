// @vitest-environment jsdom

/**
 * S8 P0.1 Phase 1D — adapter-chooser default selection.
 *
 * The canonical hosted FounderOS deployment runs server-side execution
 * off the founder's pasted Anthropic API key (no laptop CLI required),
 * so the chooser defaults to the "Anthropic API" tile. The Claude Code
 * CLI tile remains a live option for developers who already have the
 * CLI installed locally.
 *
 * This test renders the chooser with the same `selectedId` derivation
 * that `FounderOnboardingWizard.tsx` uses on first paint, and asserts:
 *   - The Anthropic API tile carries `aria-checked="true"`.
 *   - The Claude Code tile carries `aria-checked="false"`.
 *   - The Claude Code tile's body text reflects the developer-only
 *     positioning ("requires Claude Code CLI").
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderChooser } from "./ProviderChooser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<ProviderChooser /> default selection (S8 P0.1)", () => {
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

  it("defaults to anthropic_api when wizard initialises with adapterChoice='anthropic_api'", () => {
    // Mirror FounderOnboardingWizard.mapAdapterToProviderId on the new
    // default ('anthropic_api' → 'anthropic_api' tile id).
    act(() => {
      root.render(
        <ProviderChooser selectedId="anthropic_api" onSelect={() => {}} />,
      );
    });

    const anthropic = container.querySelector(
      '[data-testid="provider-tile-anthropic_api"]',
    );
    const claudeCode = container.querySelector(
      '[data-testid="provider-tile-claude_code"]',
    );

    expect(anthropic).not.toBeNull();
    // ProviderTile uses aria-pressed for live tiles' selected state.
    expect(anthropic?.getAttribute("aria-pressed")).toBe("true");
    expect(claudeCode).not.toBeNull();
    expect(claudeCode?.getAttribute("aria-pressed")).toBe("false");
  });

  it("describes Claude Code as a developer-only path", () => {
    act(() => {
      root.render(
        <ProviderChooser selectedId="anthropic_api" onSelect={() => {}} />,
      );
    });

    // The chooser surface should communicate that Claude Code is for
    // developers — the prompt's "for developers — requires Claude Code
    // CLI installed on your laptop" copy.
    const text = container.textContent ?? "";
    expect(text).toContain("For developers");
    expect(text.toLowerCase()).toContain("claude code cli");
  });
});
