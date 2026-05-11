// @vitest-environment jsdom

/**
 * BL-005 (P2.d, founder-language sweep) — ProviderTile descriptions.
 *
 * Mirrors the BL-003 label pattern for tile descriptions. The six tiles
 * used to render hardcoded engineer-language descriptions ("Bring your
 * own Anthropic API key for hosted deployments.", etc.). After P2.d they
 * consume `provider.<adapterId>.description` keys from the
 * DisplayDictionary so the copy switches based on the founder / engineer
 * viewMode stored in `founderos.viewMode`.
 *
 * acceptance coverage:
 *   1. All 6 tiles show founder-language descriptions in founder mode
 *   2. viewMode=engineer falls back to the pre-BL-005 technical copy
 *   3. All founder-mode descriptions are ≤ 100 chars (tile layout cap)
 *   4. registry: every live tile carries a `descriptionKey`
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderChooser, PROVIDER_OPTIONS } from "../ProviderChooser";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "founderos.viewMode";

/**
 * Expected descriptions per (tileId, mode). The engineer side equals the
 * pre-BL-005 technical copy that lived hardcoded in ProviderChooser.tsx,
 * preserved so engineer-mode founders see the prior surface verbatim.
 */
const EXPECTED: Record<string, { founder: string; engineer: string }> = {
  claude_code: {
    founder:
      "Use your existing Claude Code app — no extra cost beyond your Anthropic subscription.",
    engineer:
      "For developers — requires Claude Code CLI installed on your laptop.",
  },
  anthropic_api: {
    founder:
      "Pay Anthropic directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own Anthropic API key for hosted deployments.",
  },
  gemini_cli: {
    founder: "Use your Google AI subscription via Gemini CLI on your laptop.",
    engineer: "Use your Google AI subscription via the local CLI.",
  },
  google_api: {
    founder:
      "Pay Google directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own Gemini API key for hosted deployments.",
  },
  codex_cli: {
    founder: "Use your ChatGPT subscription via Codex CLI on your laptop.",
    engineer: "Use your OpenAI subscription via the local Codex CLI.",
  },
  openai_api: {
    founder:
      "Pay OpenAI directly for each agent call — runs in the cloud, no laptop required.",
    engineer: "Bring your own OpenAI API key (GPT-4o / o3).",
  },
};

function getTileDescription(container: HTMLElement, tileId: string): string {
  const el = container.querySelector(
    `[data-testid="provider-description-${tileId}"]`,
  );
  return el?.textContent ?? "";
}

describe("BL-005: ProviderTile founder-language descriptions", () => {
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

  it("registry: every live tile carries a descriptionKey (acceptance #4)", () => {
    for (const option of PROVIDER_OPTIONS) {
      if (option.status !== "live") continue;
      expect(
        option.descriptionKey,
        `tile ${option.id} must have a descriptionKey wired to DisplayDictionary`,
      ).toBeDefined();
    }
  });

  it("renders founder descriptions by default (no viewMode set)", () => {
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { founder }] of Object.entries(EXPECTED)) {
      expect(
        getTileDescription(container, tileId),
        `tile ${tileId} founder description`,
      ).toBe(founder);
    }
  });

  it("renders founder descriptions when viewMode=founder", () => {
    window.localStorage.setItem(STORAGE_KEY, "founder");
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { founder }] of Object.entries(EXPECTED)) {
      expect(
        getTileDescription(container, tileId),
        `tile ${tileId} founder description`,
      ).toBe(founder);
    }
  });

  it("falls back to engineer (technical) descriptions when viewMode=engineer (acceptance #2)", () => {
    window.localStorage.setItem(STORAGE_KEY, "engineer");
    act(() => {
      root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
    });

    for (const [tileId, { engineer }] of Object.entries(EXPECTED)) {
      expect(
        getTileDescription(container, tileId),
        `tile ${tileId} engineer description`,
      ).toBe(engineer);
    }
  });

  it("all founder-mode descriptions are ≤ 100 chars (acceptance #3)", () => {
    for (const [tileId, { founder }] of Object.entries(EXPECTED)) {
      expect(
        founder.length,
        `tile ${tileId} founder description must be ≤ 100 chars (got ${founder.length})`,
      ).toBeLessThanOrEqual(100);
    }
  });
});
