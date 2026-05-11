// @vitest-environment jsdom

/**
 * BL-003 (P2.b, founder-language sweep) — ProviderTile labels.
 *
 * The six provider tiles used to render hardcoded engineer-language
 * strings ("Anthropic API", "Codex CLI", etc.). After P2.b they consume
 * `claude_local` / `anthropic_api` / `gemini_local` / `gemini_api` /
 * `codex_local` / `openai_api` keys from the DisplayDictionary so the
 * copy switches based on the founder / engineer viewMode stored in
 * `founderos.viewMode`.
 *
 * done_criteria coverage:
 *   1. All 6 tiles show brand logo + founder-language label
 *   2. viewMode=engineer falls back to the technical name
 *   3. Existing provider-routing test (#167) still passes — see
 *      provider-routing.test.ts; unrelated to labels.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderChooser, PROVIDER_OPTIONS } from "../ProviderChooser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "founderos.viewMode";

/**
 * Expected labels per (tileId, mode) — the contract this test pins.
 * If the DisplayDictionary changes a provider label, update both here
 * and the snapshot in packages/shared/src/__snapshots__/.
 */
const EXPECTED: Record<string, { founder: string; engineer: string }> = {
  claude_code:   { founder: "Claude (subscription)",  engineer: "Claude Code CLI" },
  anthropic_api: { founder: "Claude (pay-per-use)",   engineer: "Anthropic API" },
  gemini_cli:    { founder: "Gemini (subscription)",  engineer: "Gemini CLI" },
  google_api:    { founder: "Gemini (pay-per-use)",   engineer: "Gemini API" },
  codex_cli:     { founder: "ChatGPT (subscription)", engineer: "Codex CLI" },
  openai_api:    { founder: "ChatGPT (pay-per-use)",  engineer: "OpenAI API" },
};

function getTileLabel(container: HTMLElement, tileId: string): string {
  const tile = container.querySelector(
    `[data-testid="provider-tile-${tileId}"]`,
  );
  // Tile label is the first <p> inside — the engineer/founder string.
  const labelEl = tile?.querySelector("p");
  return labelEl?.textContent ?? "";
}

describe("BL-003: ProviderTile founder-language labels", () => {
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

  it("registry: every live tile carries a displayKey (done_criteria #1)", () => {
    for (const option of PROVIDER_OPTIONS) {
      if (option.status !== "live") continue;
      expect(
        option.displayKey,
        `tile ${option.id} must have a displayKey wired to DisplayDictionary`,
      ).toBeDefined();
    }
  });

  it("renders founder labels by default (no viewMode set)", () => {
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { founder }] of Object.entries(EXPECTED)) {
      expect(
        getTileLabel(container, tileId),
        `tile ${tileId} founder label`,
      ).toBe(founder);
    }
  });

  it("renders founder labels when viewMode=founder", () => {
    window.localStorage.setItem(STORAGE_KEY, "founder");
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { founder }] of Object.entries(EXPECTED)) {
      expect(
        getTileLabel(container, tileId),
        `tile ${tileId} founder label`,
      ).toBe(founder);
    }
  });

  it("falls back to engineer (technical) labels when viewMode=engineer (done_criteria #2)", () => {
    window.localStorage.setItem(STORAGE_KEY, "engineer");
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { engineer }] of Object.entries(EXPECTED)) {
      expect(
        getTileLabel(container, tileId),
        `tile ${tileId} engineer label`,
      ).toBe(engineer);
    }
  });

  it("renders a brand logo on every live tile (done_criteria #1)", () => {
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const option of PROVIDER_OPTIONS) {
      if (option.status !== "live") continue;
      const tile = container.querySelector(
        `[data-testid="provider-tile-${option.id}"]`,
      );
      const svg = tile?.querySelector("svg");
      expect(svg, `tile ${option.id} should render a brand logo SVG`).not.toBeNull();
      // Each brand mark sets a <title> for screen readers — Anthropic /
      // OpenAI / Google. Verify it's one of those three.
      const title = svg?.querySelector("title")?.textContent ?? "";
      expect(["Anthropic", "OpenAI", "Google"]).toContain(title);
    }
  });

  it("does NOT render the pre-P2.b engineer-jargon strings in founder mode", () => {
    window.localStorage.setItem(STORAGE_KEY, "founder");
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    // Each tile's label slot (first <p>) must not contain the technical
    // string in founder mode. The descriptions still mention CLI / API
    // names — that's the requirement copy, separate from the label.
    for (const tileId of Object.keys(EXPECTED)) {
      const label = getTileLabel(container, tileId);
      expect(label, `tile ${tileId} label in founder mode`).not.toMatch(
        /^(Anthropic API|OpenAI API|Gemini API|Claude Code CLI|Codex CLI|Gemini CLI)$/,
      );
    }
  });
});
