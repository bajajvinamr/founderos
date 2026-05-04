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
