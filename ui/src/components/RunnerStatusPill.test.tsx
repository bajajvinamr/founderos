// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RunnerStatusPill,
  classifyRunnerStatus,
} from "./RunnerStatusPill";
import type { RunnerTokenSummary } from "../api/runner";
import {
  BYO_RUNNER_HOSTED_ADAPTERS,
  getAdapterDisplay,
  hasHostedRunnerAdapter,
  isHostedRunnerAdapter,
} from "../lib/runner-adapter-types";

const mockRunnerApi = vi.hoisted(() => ({
  status: vi.fn(),
}));

vi.mock("../api/runner", () => ({
  runnerApi: mockRunnerApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function summary(over: Partial<RunnerTokenSummary> = {}): RunnerTokenSummary {
  return {
    tokenId: "tok-1",
    label: "macbook",
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    online: false,
    expiresAt: null,
    expiresInDays: null,
    ...over,
  };
}

describe("classifyRunnerStatus", () => {
  it("returns missing when token list is empty", () => {
    expect(classifyRunnerStatus([])).toEqual({
      kind: "missing",
      onlineCount: 0,
    });
  });

  it("returns stale when tokens exist but none online", () => {
    expect(classifyRunnerStatus([summary({ online: false })])).toEqual({
      kind: "stale",
      onlineCount: 0,
    });
  });

  it("returns online with count when at least one token is online", () => {
    const result = classifyRunnerStatus([
      summary({ tokenId: "a", online: true }),
      summary({ tokenId: "b", online: false }),
      summary({ tokenId: "c", online: true }),
    ]);
    expect(result).toEqual({ kind: "online", onlineCount: 2 });
  });
});

describe("<RunnerStatusPill />", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockRunnerApi.status.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  });

  function render(companyId = "company-1") {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RunnerStatusPill companyId={companyId} onClick={() => {}} />
        </QueryClientProvider>,
      );
    });
  }

  async function flushQuery(predicate?: () => boolean) {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      if (!predicate || predicate()) return;
    }
  }

  it("renders the loading label initially", () => {
    mockRunnerApi.status.mockReturnValue(new Promise(() => {}));
    render();
    expect(container.textContent).toContain("Checking runner");
  });

  it("renders missing state for empty token list", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(() => container.textContent?.includes("Install runner") ?? false);
    expect(container.textContent).toContain("Install runner");
    const dot = container.querySelector('[data-testid="runner-status-dot"]');
    expect(dot?.className).toContain("bg-rose-500");
  });

  it("renders stale state when tokens are offline", async () => {
    mockRunnerApi.status.mockResolvedValue({
      tokens: [summary({ online: false })],
    });
    render();
    await flushQuery(() => container.textContent?.includes("Runner stale") ?? false);
    expect(container.textContent).toContain("Runner stale");
    const dot = container.querySelector('[data-testid="runner-status-dot"]');
    expect(dot?.className).toContain("bg-amber-500");
  });

  it("renders online state without count for a single online runner", async () => {
    mockRunnerApi.status.mockResolvedValue({
      tokens: [summary({ online: true })],
    });
    render();
    await flushQuery(() => container.textContent?.includes("Runner online") ?? false);
    expect(container.textContent).toContain("Runner online");
    expect(container.textContent).not.toContain("(2)");
    const dot = container.querySelector('[data-testid="runner-status-dot"]');
    expect(dot?.className).toContain("bg-emerald-500");
  });

  it("renders online state with count when multiple runners online", async () => {
    mockRunnerApi.status.mockResolvedValue({
      tokens: [
        summary({ tokenId: "a", online: true }),
        summary({ tokenId: "b", online: true }),
      ],
    });
    render();
    await flushQuery(() => container.textContent?.includes("Runner online (2)") ?? false);
    expect(container.textContent).toContain("Runner online (2)");
  });

  it("renders error state when the request fails", async () => {
    mockRunnerApi.status.mockRejectedValue(new Error("boom"));
    render();
    await flushQuery(() => container.textContent?.includes("Runner status unavailable") ?? false);
    expect(container.textContent).toContain("Runner status unavailable");
    const dot = container.querySelector('[data-testid="runner-status-dot"]');
    expect(dot?.className).toContain("bg-rose-500");
  });

  it("invokes onClick when the pill is clicked", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    const handleClick = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RunnerStatusPill companyId="c1" onClick={handleClick} />
        </QueryClientProvider>,
      );
    });
    await flushQuery(() => container.textContent?.includes("Install runner") ?? false);
    const button = container.querySelector('[data-testid="runner-status-pill"]');
    act(() => {
      (button as HTMLButtonElement).click();
    });
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// S7.B.7 — Hosted-runner adapter gating + display registry
// ---------------------------------------------------------------------------

describe("BYO_RUNNER_HOSTED_ADAPTERS", () => {
  // 2026-05-18 (G8) — Reclassified openai_api / anthropic_api / gemini_api
  // OUT of BYO_RUNNER_HOSTED_ADAPTERS. They're hosted-API adapters that
  // run server-side via apiKeyResolver, NOT BYO-hosted CLIs. The set now
  // contains only the four CLI-family adapter types.
  it("includes the four CLI-family adapter types", () => {
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("claude_local")).toBe(true);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("codex_local")).toBe(true);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("gemini_local")).toBe(true);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("opencode_local")).toBe(true);
  });

  it("EXCLUDES hosted-API families (openai_api / anthropic_api / gemini_api)", () => {
    // These run server-side via apiKeyResolver — NOT BYO. Regression
    // guard for the 2026-05-18 reclassification (G8 follow-on).
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("openai_api")).toBe(false);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("anthropic_api")).toBe(false);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("gemini_api")).toBe(false);
  });

  it("excludes server-side adapter types (process, http)", () => {
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("process")).toBe(false);
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("http")).toBe(false);
  });

  it("excludes the legacy byo_runner sentinel (reclassified in S7.B.5)", () => {
    expect(BYO_RUNNER_HOSTED_ADAPTERS.has("byo_runner")).toBe(false);
  });
});

describe("isHostedRunnerAdapter", () => {
  it.each([
    ["claude_local", true],
    ["codex_local", true],
    ["gemini_local", true],
    ["opencode_local", true],
    // Hosted-API families return false — they're server-side, not BYO.
    ["openai_api", false],
    ["anthropic_api", false],
    ["gemini_api", false],
    ["process", false],
    ["http", false],
    ["byo_runner", false],
    ["unknown_type", false],
    ["", false],
  ] as const)("isHostedRunnerAdapter(%s) === %s", (adapterType, expected) => {
    expect(isHostedRunnerAdapter(adapterType)).toBe(expected);
  });

  it("returns false for null / undefined adapter types", () => {
    expect(isHostedRunnerAdapter(null)).toBe(false);
    expect(isHostedRunnerAdapter(undefined)).toBe(false);
  });
});

describe("hasHostedRunnerAdapter", () => {
  it("returns true when at least one agent uses a hosted-runner adapter", () => {
    const agents = [
      { adapterType: "process" },
      { adapterType: "claude_local" },
    ];
    expect(hasHostedRunnerAdapter(agents)).toBe(true);
  });

  it.each(["claude_local", "codex_local", "gemini_local", "opencode_local"])(
    "returns true for an agent list with only %s",
    (adapterType) => {
      expect(hasHostedRunnerAdapter([{ adapterType }])).toBe(true);
    },
  );

  it("returns false for an agent list of only hosted-API adapters", () => {
    // openai_api / anthropic_api / gemini_api are server-side, not BYO —
    // an agent list of only these should NOT show the runner pill.
    expect(
      hasHostedRunnerAdapter([
        { adapterType: "openai_api" },
        { adapterType: "anthropic_api" },
      ]),
    ).toBe(false);
  });

  it("returns false for an agent list of only process / http", () => {
    expect(
      hasHostedRunnerAdapter([
        { adapterType: "process" },
        { adapterType: "http" },
      ]),
    ).toBe(false);
  });

  it("returns false for an empty / null / undefined agent list", () => {
    expect(hasHostedRunnerAdapter([])).toBe(false);
    expect(hasHostedRunnerAdapter(null)).toBe(false);
    expect(hasHostedRunnerAdapter(undefined)).toBe(false);
  });

  it("ignores agents without an adapter type", () => {
    expect(
      hasHostedRunnerAdapter([
        { adapterType: null },
        { adapterType: undefined },
      ]),
    ).toBe(false);
  });
});

describe("getAdapterDisplay", () => {
  it("returns display metadata for hosted-runner types with the expected labels", () => {
    expect(getAdapterDisplay("claude_local")).toMatchObject({
      label: "Claude Code",
      shortLabel: "Claude",
      family: "anthropic",
    });
    expect(getAdapterDisplay("codex_local")).toMatchObject({
      label: "Codex CLI",
      shortLabel: "Codex",
      family: "openai",
    });
    expect(getAdapterDisplay("gemini_local")).toMatchObject({
      label: "Gemini CLI",
      shortLabel: "Gemini",
      family: "google",
    });
    expect(getAdapterDisplay("openai_api")).toMatchObject({
      label: "OpenAI API",
      shortLabel: "OpenAI",
      family: "openai",
    });
  });

  it("returns null for server-side, unknown, or missing adapter types", () => {
    expect(getAdapterDisplay("process")).toBeNull();
    expect(getAdapterDisplay("http")).toBeNull();
    expect(getAdapterDisplay("byo_runner")).toBeNull();
    expect(getAdapterDisplay("unknown_type")).toBeNull();
    expect(getAdapterDisplay(null)).toBeNull();
    expect(getAdapterDisplay(undefined)).toBeNull();
    expect(getAdapterDisplay("")).toBeNull();
  });
});
