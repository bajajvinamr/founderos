// @vitest-environment jsdom

/**
 * AiConnections.test.tsx — BL-016 / P5.a page scaffold tests.
 *
 * Covers:
 *   1. Page renders the four required sections.
 *   2. Connected list shows adapters returned from the API, with status pills.
 *   3. Fallback-order reorder helper moves items correctly (pure-function test).
 *   4. Reorder up/down buttons disable correctly at boundaries.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiConnections, reorderFallback } from "./AiConnections";
import type { AiConnectionRow } from "@/api/ai-connections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Mocks ────────────────────────────────────────────────────────────────────

const listMock = vi.fn<() => Promise<AiConnectionRow[]>>();

vi.mock("@/api/ai-connections", async () => {
  const actual = await vi.importActual<typeof import("@/api/ai-connections")>("@/api/ai-connections");
  return {
    ...actual,
    aiConnectionsApi: {
      list: () => listMock(),
    },
  };
});

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// ── Test harness ─────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  listMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  queryClient.clear();
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function renderPage() {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AiConnections />
      </QueryClientProvider>,
    );
    await flush();
  });
  // One more flush so the post-query useEffect that seeds fallback order fires.
  await act(async () => {
    await flush();
  });
}

const sampleRows: AiConnectionRow[] = [
  {
    type: "claude_local",
    label: "Claude Code (local)",
    source: "builtin",
    status: "connected",
    modelsCount: 3,
  },
  {
    type: "codex_local",
    label: "Codex (local)",
    source: "builtin",
    status: "connected",
    modelsCount: 2,
    version: "0.1.0",
  },
  {
    type: "gemini_local",
    label: "Gemini CLI (local)",
    source: "builtin",
    status: "validation_needed",
    modelsCount: 0,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AiConnections page", () => {
  it("renders the four spec sections after data loads", async () => {
    listMock.mockResolvedValue(sampleRows);
    await renderPage();

    expect(container!.querySelector("[data-testid=ai-connections-page]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=connected-section]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=default-section]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=per-department-section]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=fallback-section]")).not.toBeNull();
  });

  it("renders one row per connected adapter with its status pill", async () => {
    listMock.mockResolvedValue(sampleRows);
    await renderPage();

    expect(container!.querySelector("[data-testid=connection-row-claude_local]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=connection-row-codex_local]")).not.toBeNull();
    expect(container!.querySelector("[data-testid=connection-row-gemini_local]")).not.toBeNull();

    // Two connected → two connected pills; one validation_needed → one amber pill.
    const connectedPills = container!.querySelectorAll("[data-testid=ai-connection-status-connected]");
    const validationPills = container!.querySelectorAll(
      "[data-testid=ai-connection-status-validation_needed]",
    );
    expect(connectedPills.length).toBe(2);
    expect(validationPills.length).toBe(1);
  });

  it("seeds the fallback order from connected adapters and disables boundary buttons", async () => {
    listMock.mockResolvedValue(sampleRows);
    await renderPage();

    // Only the two `connected` rows seed fallback order; validation_needed is excluded.
    const entries = container!.querySelectorAll("[data-testid^=fallback-entry-]");
    expect(entries.length).toBe(2);

    const firstUp = container!.querySelector(
      "[data-testid=fallback-up-claude_local]",
    ) as HTMLButtonElement | null;
    const lastDown = container!.querySelector(
      "[data-testid=fallback-down-codex_local]",
    ) as HTMLButtonElement | null;
    expect(firstUp?.disabled).toBe(true);
    expect(lastDown?.disabled).toBe(true);
  });

  it("shows empty-state copy when no adapters are returned", async () => {
    listMock.mockResolvedValue([]);
    await renderPage();

    const connectedSection = container!.querySelector("[data-testid=connected-section]");
    expect(connectedSection?.textContent).toContain("No AI providers connected yet");
  });
});

// ── Pure helper tests (no DOM) ───────────────────────────────────────────────

describe("reorderFallback", () => {
  const a = { adapterType: "a", label: "A" };
  const b = { adapterType: "b", label: "B" };
  const c = { adapterType: "c", label: "C" };

  it("moves an item from index 0 to index 1", () => {
    expect(reorderFallback([a, b, c], 0, 1)).toEqual([b, a, c]);
  });

  it("moves an item from index 2 to index 0", () => {
    expect(reorderFallback([a, b, c], 2, 0)).toEqual([c, a, b]);
  });

  it("returns the same list when from === to", () => {
    const list = [a, b, c];
    expect(reorderFallback(list, 1, 1)).toEqual(list);
  });

  it("returns the same list when indexes are out of range", () => {
    const list = [a, b, c];
    expect(reorderFallback(list, -1, 0)).toEqual(list);
    expect(reorderFallback(list, 0, 99)).toEqual(list);
  });
});
