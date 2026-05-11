// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentProviderBadge } from "./AgentProviderBadge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * S8 P0.1 Phase 2B — UI gating for hosted Claude agents.
 *
 * The "Hosted on FounderOS" affordance is build-time gated by
 * `VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED`. We `vi.stubEnv` per test so the
 * same component module covers both modes without re-importing.
 */
describe("<AgentProviderBadge />", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllEnvs();
  });

  it("renders the CLI affordance for claude_local when hosted flag is OFF", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "0");
    act(() => {
      root.render(<AgentProviderBadge adapterType="claude_local" />);
    });
    expect(container.querySelector('[data-testid="agent-provider-badge-hosted"]')).toBeNull();
    // CLI icon's aria-label is "CLI"; hosted swap would replace it with "Hosted on FounderOS".
    const cliIcon = container.querySelector('[aria-label="CLI"]');
    expect(cliIcon).not.toBeNull();
  });

  it("swaps to the Hosted on FounderOS badge for claude_local when hosted flag is ON", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "1");
    act(() => {
      root.render(<AgentProviderBadge adapterType="claude_local" />);
    });
    const hosted = container.querySelector('[data-testid="agent-provider-badge-hosted"]');
    expect(hosted).not.toBeNull();
    expect(hosted?.textContent).toContain("Hosted on FounderOS");
    // Cloud icon replaces the CLI/Zap affordance.
    expect(container.querySelector('[aria-label="Hosted on FounderOS"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="CLI"]')).toBeNull();
  });

  it("preserves the model label when hosted, falling back to 'Hosted on FounderOS' if no model", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "1");
    act(() => {
      root.render(<AgentProviderBadge adapterType="claude_local" model="claude-opus-4-7" />);
    });
    const hosted = container.querySelector('[data-testid="agent-provider-badge-hosted"]');
    expect(hosted?.textContent).toContain("claude-opus-4-7");
  });

  it("does NOT render the hosted badge for byo_runner agents (laptop runner stays as-is)", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "1");
    act(() => {
      root.render(<AgentProviderBadge adapterType="byo_runner" />);
    });
    expect(container.querySelector('[data-testid="agent-provider-badge-hosted"]')).toBeNull();
  });

  it("does NOT render the hosted badge for non-claude adapters even when hosted flag is ON", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "1");
    act(() => {
      root.render(<AgentProviderBadge adapterType="gemini_local" />);
    });
    expect(container.querySelector('[data-testid="agent-provider-badge-hosted"]')).toBeNull();
    // Gemini is a CLI adapter regardless of hosted flag.
    expect(container.querySelector('[aria-label="CLI"]')).not.toBeNull();
  });

  it("returns null when adapterType is null/undefined", () => {
    vi.stubEnv("VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED", "1");
    act(() => {
      root.render(<AgentProviderBadge adapterType={null} />);
    });
    expect(container.children.length).toBe(0);
  });
});
