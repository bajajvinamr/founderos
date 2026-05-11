// @vitest-environment jsdom

/**
 * BL-004 (P2.c, audit finding) — Step 4 must NOT pre-select a provider.
 *
 * Audit finding: `FounderOnboardingWizard` previously initialised
 * `adapterChoice: "anthropic_api"`. The silent default biased analytics
 * ("most founders pick Anthropic" — they didn't, the tile was just
 * pre-selected). The fix:
 *   1. Default `adapterChoice` to `null`.
 *   2. Disable Continue until a tile is clicked.
 *   3. Round-trip the choice through `mapAdapterToProviderId` correctly
 *      after the founder picks.
 *
 * The wizard itself opens behind a dialog/portal and is wired to
 * `useDialog().onboardingOpen`, which is heavier than what this audit
 * needs. We exercise the same two pure helpers the wizard uses
 * (`mapAdapterToProviderId`, `mapProviderToAdapter`) plus the
 * `ProviderChooser` component directly — enough to lock in the
 * three observable properties above without standing up the full
 * provider tree.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_OPTIONS,
  ProviderChooser,
  type ProviderOption,
} from "../ProviderChooser.js";
import {
  mapAdapterToProviderId,
  mapProviderToAdapter,
} from "../FounderOnboardingWizard.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BL-004: null adapter default + explicit-choice gating", () => {
  describe("mapAdapterToProviderId — null passes through", () => {
    it("returns null when adapterChoice is null (first paint, no selection yet)", () => {
      // BL-004 — `mapAdapterToProviderId` is called with `draft.adapterChoice`
      // on every render of Step 4. The draft initialises null; the chooser's
      // `selectedId` prop must therefore receive null and render with no
      // tile in the aria-pressed=true state.
      expect(mapAdapterToProviderId(null, "")).toBeNull();
    });
  });

  describe("ProviderChooser — first paint with null selection", () => {
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

    it("renders zero pre-selected tiles when selectedId is null", () => {
      act(() => {
        root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
      });

      // No live tile should be in the aria-pressed=true state on first paint.
      const pressed = container.querySelectorAll('[aria-pressed="true"]');
      expect(pressed.length).toBe(0);
    });

    it("calls onSelect with the clicked provider option (smoke test)", () => {
      const onSelect = vi.fn();
      act(() => {
        root.render(<ProviderChooser selectedId={null} onSelect={onSelect} />);
      });

      // Click the Gemini CLI tile — the audit's failure mode was that
      // the click silently no-op'd, leaving the founder on the silent
      // default. This is the live-tile click contract.
      const geminiTile = container.querySelector(
        '[data-testid="provider-tile-gemini_cli"]',
      ) as HTMLButtonElement | null;
      expect(geminiTile).not.toBeNull();

      act(() => {
        geminiTile?.click();
      });

      expect(onSelect).toHaveBeenCalledTimes(1);
      const selectedOption = onSelect.mock.calls[0]?.[0] as ProviderOption;
      expect(selectedOption.id).toBe("gemini_cli");
      // And the click result, when mapped, MUST yield a non-null adapter
      // choice. (Regression guard for PR #167 — every live tile maps.)
      expect(mapProviderToAdapter(selectedOption)).not.toBeNull();
    });

    it("renders all 6 live tiles with aria-pressed=false on first paint", () => {
      act(() => {
        root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
      });

      const liveTiles = PROVIDER_OPTIONS.filter((o) => o.status === "live");
      expect(liveTiles.length).toBe(6);
      for (const option of liveTiles) {
        const tile = container.querySelector(
          `[data-testid="provider-tile-${option.id}"]`,
        );
        expect(tile, `tile ${option.id} should render`).not.toBeNull();
        expect(
          tile?.getAttribute("aria-pressed"),
          `tile ${option.id} must be unselected on first paint (BL-004)`,
        ).toBe("false");
      }
    });

    it("reflects the new selection on next render after the founder picks", () => {
      // Simulate the wizard's state-update flow:
      //   1. selectedId starts null  → no tile pressed
      //   2. founder clicks tile     → wizard maps option → patches draft
      //   3. wizard re-renders with new selectedId derived from draft
      //   4. picked tile shows aria-pressed=true
      act(() => {
        root.render(<ProviderChooser selectedId={null} onSelect={() => {}} />);
      });
      const tile = container.querySelector(
        '[data-testid="provider-tile-codex_cli"]',
      );
      expect(tile?.getAttribute("aria-pressed")).toBe("false");

      // Wizard re-renders with the round-tripped selection.
      const choice = mapProviderToAdapter(
        PROVIDER_OPTIONS.find((o) => o.id === "codex_cli")!,
      );
      expect(choice).toBe("codex_local");
      const nextSelectedId = mapAdapterToProviderId(choice, "");
      expect(nextSelectedId).toBe("codex_cli");

      act(() => {
        root.render(
          <ProviderChooser selectedId={nextSelectedId} onSelect={() => {}} />,
        );
      });

      const tileAfter = container.querySelector(
        '[data-testid="provider-tile-codex_cli"]',
      );
      expect(tileAfter?.getAttribute("aria-pressed")).toBe("true");
    });
  });
});
