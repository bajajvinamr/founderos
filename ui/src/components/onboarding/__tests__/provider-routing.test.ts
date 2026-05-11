/**
 * Provider routing unit tests — fix verification for the silent no-op bug.
 *
 * Bug (confirmed by 3 audits):
 *   `mapProviderToAdapter` only handled `claude_code` and `anthropic_api`.
 *   The remaining 4 live tile IDs returned `null`, causing the wizard's
 *   click handler guard (`if (nextChoice === null) return;`) to silently
 *   swallow the selection. Draft retained its default `adapterChoice:
 *   "anthropic_api"` regardless of what the founder clicked.
 *
 * These tests verify the fix: every live tile ID maps to a non-null,
 * canonical `OnboardingAdapterChoice` value, and the reverse mapping
 * (`mapAdapterToProviderId`) round-trips correctly.
 *
 * Cross-reference: FounderOnboardingWizard.tsx mapProviderToAdapter,
 *   ProviderChooser.tsx PROVIDER_OPTIONS, PR feat/fix-provider-routing.
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_OPTIONS, type ProviderOption } from "../ProviderChooser.js";
import {
  mapProviderToAdapter,
  mapAdapterToProviderId,
} from "../FounderOnboardingWizard.js";
import type { OnboardingDraft } from "../onboarding-types.js";

// ──────────────────────────────────────────────────────────────────────────
// mapProviderToAdapter — every live tile resolves to a non-null adapter
// ──────────────────────────────────────────────────────────────────────────

describe("mapProviderToAdapter", () => {
  const liveTiles = PROVIDER_OPTIONS.filter((o) => o.status === "live");

  it("covers all 6 live tiles (sanity check that the registry has not shrunk)", () => {
    expect(liveTiles).toHaveLength(6);
  });

  it.each(liveTiles)(
    "tile '$id' returns a non-null adapter choice",
    (option: ProviderOption) => {
      const result = mapProviderToAdapter(option);
      expect(result).not.toBeNull();
    },
  );

  it("claude_code → claude_local", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "claude_code")!;
    expect(mapProviderToAdapter(option)).toBe("claude_local");
  });

  it("anthropic_api → anthropic_api", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "anthropic_api")!;
    expect(mapProviderToAdapter(option)).toBe("anthropic_api");
  });

  it("gemini_cli → gemini_local", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "gemini_cli")!;
    expect(mapProviderToAdapter(option)).toBe("gemini_local");
  });

  it("google_api → google_api", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "google_api")!;
    expect(mapProviderToAdapter(option)).toBe("google_api");
  });

  it("codex_cli → codex_local", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "codex_cli")!;
    expect(mapProviderToAdapter(option)).toBe("codex_local");
  });

  it("openai_api → openai_api", () => {
    const option = PROVIDER_OPTIONS.find((o) => o.id === "openai_api")!;
    expect(mapProviderToAdapter(option)).toBe("openai_api");
  });

  it("returns null for a coming-soon tile (status guard is intact)", () => {
    const comingSoon: ProviderOption = {
      id: "future_provider",
      label: "Future",
      description: "Coming soon",
      requirement: "TBD",
      status: "coming-soon",
      adapterType: "claude_local",
      authMode: "api_key",
    };
    expect(mapProviderToAdapter(comingSoon)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// mapAdapterToProviderId — reverse mapping for chooser selectedId prop
// ──────────────────────────────────────────────────────────────────────────

describe("mapAdapterToProviderId", () => {
  type Choice = OnboardingDraft["adapterChoice"];

  const cases: Array<[Choice, string]> = [
    ["claude_local", "claude_code"],
    ["anthropic_api", "anthropic_api"],
    ["gemini_local", "gemini_cli"],
    ["google_api", "google_api"],
    ["codex_local", "codex_cli"],
    ["openai_api", "openai_api"],
  ];

  it.each(cases)(
    "adapterChoice '%s' → tile id '%s'",
    (choice: Choice, expectedTileId: string) => {
      expect(mapAdapterToProviderId(choice, "")).toBe(expectedTileId);
    },
  );

  it("skip → null (no tile represents the skip state)", () => {
    expect(mapAdapterToProviderId("skip", "")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Round-trip: tile selection → adapterChoice → back to tile id
// ──────────────────────────────────────────────────────────────────────────

describe("round-trip: tile id → adapter → tile id", () => {
  const roundTrippableTiles = [
    "claude_code",
    "anthropic_api",
    "gemini_cli",
    "google_api",
    "codex_cli",
    "openai_api",
  ];

  it.each(roundTrippableTiles)(
    "tile '%s' round-trips cleanly",
    (tileId: string) => {
      const option = PROVIDER_OPTIONS.find((o) => o.id === tileId)!;
      expect(option).toBeDefined();

      const adapterChoice = mapProviderToAdapter(option);
      expect(adapterChoice).not.toBeNull();

      const recoveredTileId = mapAdapterToProviderId(adapterChoice!, "");
      expect(recoveredTileId).toBe(tileId);
    },
  );
});
