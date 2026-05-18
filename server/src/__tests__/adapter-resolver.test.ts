import { describe, it, expect } from "vitest";
import {
  mapOnboardingChoiceToAdapter,
  resolveAgentAdapter,
  resolveAgentAdaptersBatch,
  type ProviderAvailability,
} from "../services/adapter-resolver.js";
import {
  ONBOARDING_ADAPTER_CHOICES,
  type AgentProviderPreference,
  type OnboardingAdapterChoice,
} from "@founderos/shared";

const allAvailable: ProviderAvailability = {
  anthropic: { api: true, cli: true },
  openai: { api: true, cli: true },
  google: { api: true, cli: true },
  anyConfigured: true,
};

const onlyAnthropicCli: ProviderAvailability = {
  anthropic: { api: false, cli: true },
  openai: { api: false, cli: false },
  google: { api: false, cli: false },
  anyConfigured: true,
};

const onlyOpenaiApi: ProviderAvailability = {
  anthropic: { api: false, cli: false },
  openai: { api: true, cli: false },
  google: { api: false, cli: false },
  anyConfigured: true,
};

const empty: ProviderAvailability = {
  anthropic: { api: false, cli: false },
  openai: { api: false, cli: false },
  google: { api: false, cli: false },
  anyConfigured: false,
};

const reasoningPref: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-opus-4-6",
    openai: "gpt-5",
    google: "gemini-2.5-pro",
  },
  preferredExecution: "cli",
};

describe("resolveAgentAdapter", () => {
  it("picks Anthropic CLI when everything is available (respects family priority + CLI preference)", () => {
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability: allAvailable,
      strategy: "mixed",
    });
    expect(result).toEqual({
      adapterType: "claude_local",
      model: "claude-opus-4-6",
      family: "anthropic",
      execution: "cli",
    });
  });

  it("falls back from CLI to API within the same family when CLI is missing", () => {
    // BYO-108: Anthropic has no `api` adapter (claude_api was phantom).
    // Use OpenAI for this test so the CLI→API within-family fallback path
    // is exercised against a real adapter mapping. The Anthropic-only-API
    // case is now covered by the next test ("returns no_provider...").
    const availability: ProviderAvailability = {
      anthropic: { api: false, cli: false },
      openai: { api: true, cli: false },
      google: { api: false, cli: false },
      anyConfigured: true,
    };
    const cliPref: AgentProviderPreference = {
      ...reasoningPref,
      families: ["openai"],
      preferredExecution: "cli",
    };
    const result = resolveAgentAdapter({
      preference: cliPref,
      availability,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      adapterType: "openai_api",
      family: "openai",
      execution: "api",
    });
  });

  it("BYO-108: Anthropic-only-API availability falls through to next family (no claude_api adapter)", () => {
    // Pre-BYO-108 this returned adapterType="claude_api" — a phantom adapter
    // that wasn't actually registered. Now the resolver skips Anthropic when
    // CLI is unavailable and the user has only an Anthropic API key.
    const availability: ProviderAvailability = {
      anthropic: { api: true, cli: false },
      openai: { api: true, cli: false },
      google: { api: false, cli: false },
      anyConfigured: true,
    };
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      adapterType: "openai_api",
      family: "openai",
      execution: "api",
    });
  });

  it("falls back to the next family when the first has no credentials", () => {
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability: onlyOpenaiApi,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      adapterType: "openai_api",
      family: "openai",
      execution: "api",
    });
  });

  it("honors openai_first strategy even when template prefers anthropic", () => {
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability: allAvailable,
      strategy: "openai_first",
    });
    expect(result).toMatchObject({
      adapterType: "codex_local",
      family: "openai",
    });
  });

  it("honors explicit override strategy (kind=override)", () => {
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability: allAvailable,
      strategy: {
        kind: "override",
        adapterType: "gemini_local",
        model: "gemini-2.5-flash",
      },
    });
    expect(result).toEqual({
      adapterType: "gemini_local",
      model: "gemini-2.5-flash",
      family: "google",
      execution: "cli",
    });
  });

  it("returns no_provider error when nothing is configured", () => {
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability: empty,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      kind: "no_provider",
    });
  });

  it("handles missing preference by using default preference (anthropic → openai → google)", () => {
    const result = resolveAgentAdapter({
      preference: undefined,
      availability: onlyAnthropicCli,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      adapterType: "claude_local",
      family: "anthropic",
    });
  });
});

describe("resolveAgentAdaptersBatch", () => {
  it("resolves every agent or returns the first failing one", () => {
    const result = resolveAgentAdaptersBatch({
      agents: [
        { key: "a", preference: reasoningPref },
        { key: "b", preference: reasoningPref },
      ],
      availability: allAvailable,
      strategy: "mixed",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.resolved).sort()).toEqual(["a", "b"]);
    }
  });

  it("reports which agent caused the failure", () => {
    const pickyPref: AgentProviderPreference = {
      families: ["google"],
      suggestedModels: { google: "gemini-2.5-pro" },
      preferredExecution: "cli",
    };
    const result = resolveAgentAdaptersBatch({
      agents: [
        { key: "a", preference: reasoningPref },
        { key: "picky", preference: pickyPref },
      ],
      availability: onlyAnthropicCli,
      strategy: "mixed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failingAgentKey).toBe("picky");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S7.0.2 — mapOnboardingChoiceToAdapter
// ──────────────────────────────────────────────────────────────────────────

describe("mapOnboardingChoiceToAdapter (S7.0.2)", () => {
  // Identity mappings: every CLI choice should map to the same string used
  // in `runner_jobs.adapter_type` CHECK + `agents.adapter_type`.
  const cliIdentityCases: Array<[OnboardingAdapterChoice, string]> = [
    ["claude_local", "claude_local"],
    ["codex_local", "codex_local"],
    ["gemini_local", "gemini_local"],
    ["opencode_local", "opencode_local"],
    ["pi_local", "pi_local"],
    ["cursor_local", "cursor_local"],
    ["hermes_local", "hermes_local"],
  ];

  for (const [choice, expected] of cliIdentityCases) {
    it(`maps ${choice} → ${expected} (identity for CLI choices)`, () => {
      expect(mapOnboardingChoiceToAdapter(choice)).toBe(expected);
    });
  }

  // G3b (2026-05-18) — anthropic_api now maps to the dedicated server-side
  // anthropic_api adapter package. Pre-G3b it collapsed to claude_local
  // because no Anthropic-API adapter existed. The dedicated package now
  // calls the Anthropic SDK in-process; the collapse is gone.
  it("maps anthropic_api → anthropic_api (dedicated server-side adapter, G3b)", () => {
    expect(mapOnboardingChoiceToAdapter("anthropic_api")).toBe("anthropic_api");
  });

  it("maps openai_api → openai_api (1:1 with registered adapter)", () => {
    expect(mapOnboardingChoiceToAdapter("openai_api")).toBe("openai_api");
  });

  it("maps google_api → gemini_api (backwards-compatible rename in Phase C3)", () => {
    expect(mapOnboardingChoiceToAdapter("google_api")).toBe("gemini_api");
  });

  it("maps skip → claude_local (preserves pre-S7 default)", () => {
    expect(mapOnboardingChoiceToAdapter("skip")).toBe("claude_local");
  });

  // Exhaustiveness — every value in ONBOARDING_ADAPTER_CHOICES must map
  // to a non-empty adapter type. Catches new entries that forget to extend
  // the helper or entries that still throw unsupported errors.
  it("maps every ONBOARDING_ADAPTER_CHOICES value to a valid adapter type", () => {
    for (const choice of ONBOARDING_ADAPTER_CHOICES) {
      const mapped = mapOnboardingChoiceToAdapter(choice);
      expect(typeof mapped).toBe("string");
      expect(mapped.length).toBeGreaterThan(0);
    }
  });
});
