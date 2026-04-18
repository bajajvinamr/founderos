import { describe, it, expect } from "vitest";
import {
  resolveAgentAdapter,
  resolveAgentAdaptersBatch,
  type ProviderAvailability,
} from "../services/adapter-resolver.js";
import type { AgentProviderPreference } from "@founderos/shared";

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
    const availability: ProviderAvailability = {
      anthropic: { api: true, cli: false },
      openai: { api: false, cli: false },
      google: { api: false, cli: false },
      anyConfigured: true,
    };
    const result = resolveAgentAdapter({
      preference: reasoningPref,
      availability,
      strategy: "mixed",
    });
    expect(result).toMatchObject({
      adapterType: "claude_api",
      family: "anthropic",
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
