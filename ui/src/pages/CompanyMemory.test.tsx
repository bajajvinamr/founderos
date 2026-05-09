// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyMemoryEntry } from "@founderos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for context + api before importing the page so the lazy/static imports
// inside CompanyMemory pick them up.

const setBreadcrumbsMock = vi.fn();
const memoryListMock = vi.fn<(companyId: string, params?: unknown) => Promise<CompanyMemoryEntry[]>>();
const memoryCreateMock = vi.fn();
const memoryUpdateMock = vi.fn();
const memoryRemoveMock = vi.fn();

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/memory", search: "", hash: "" }),
  useParams: () => ({}),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../api/company-memory", () => ({
  companyMemoryApi: {
    list: (companyId: string, params?: unknown) => memoryListMock(companyId, params),
    create: (companyId: string, body: unknown) => memoryCreateMock(companyId, body),
    update: (companyId: string, entryId: string, body: unknown) =>
      memoryUpdateMock(companyId, entryId, body),
    remove: (companyId: string, entryId: string) => memoryRemoveMock(companyId, entryId),
    generateWeekly: vi.fn(),
  },
}));

// Light shadcn select stub — the real one uses Radix portals which are noisy
// in jsdom and not what we're testing here.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div data-testid="select">{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  SelectValue: () => null,
}));

import { CompanyMemory, MemoryList } from "./CompanyMemory";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeEntry(overrides: Partial<CompanyMemoryEntry> = {}): CompanyMemoryEntry {
  return {
    id: "mem-1",
    companyId: "company-1",
    kind: "founder_note",
    title: "Test memory",
    body: "Body of the memory",
    topic: null,
    occurredAt: new Date("2026-04-14T00:00:00.000Z"),
    pinned: false,
    source: "manual",
    category: null,
    expiresAt: null,
    createdAt: new Date("2026-04-14T00:00:00.000Z"),
    updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    ...overrides,
  };
}

async function flush() {
  // Multiple ticks: react-query needs a microtask + a macrotask + another
  // microtask after the queryFn settles before its data is observable.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { container, root, queryClient };
}

describe("CompanyMemory page", () => {
  beforeEach(() => {
    setBreadcrumbsMock.mockReset();
    memoryListMock.mockReset();
    memoryCreateMock.mockReset();
    memoryUpdateMock.mockReset();
    memoryRemoveMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the empty-state CTA when there are no entries", async () => {
    memoryListMock.mockResolvedValue([]);

    const { container, root, queryClient } = render(<CompanyMemory />);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyMemory />
        </QueryClientProvider>,
      );
    });
    // Drain the queryFn promise + react-query commit cycle.
    await act(async () => {
      await flush();
    });

    expect(memoryListMock).toHaveBeenCalledWith("company-1", { limit: 200 });
    expect(container.textContent).toContain("Company Memory");
    expect(container.textContent).toContain("No memory entries yet");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders three entries as cards", async () => {
    const entries = [
      makeEntry({ id: "mem-1", title: "Pricing decision", category: "decision" }),
      makeEntry({ id: "mem-2", title: "Churn pattern", category: "pattern" }),
      makeEntry({ id: "mem-3", title: "Customer fact", category: "context" }),
    ];
    memoryListMock.mockResolvedValue(entries);

    const { container, root, queryClient } = render(<CompanyMemory />);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyMemory />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("Pricing decision");
    expect(container.textContent).toContain("Churn pattern");
    expect(container.textContent).toContain("Customer fact");
    const cards = container.querySelectorAll('[data-testid="memory-card"]');
    expect(cards.length).toBe(3);

    await act(async () => {
      root.unmount();
    });
  });

  it("opens the add form when 'Add memory' is clicked", async () => {
    memoryListMock.mockResolvedValue([makeEntry()]);

    const { container, root, queryClient } = render(<CompanyMemory />);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyMemory />
        </QueryClientProvider>,
      );
      await flush();
    });

    // Form is hidden by default — title input only appears when composing.
    expect(container.querySelector("#memory-title")).toBeNull();

    const addButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add memory"),
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton?.click();
      await flush();
    });

    expect(container.querySelector("#memory-title")).not.toBeNull();
    expect(container.querySelector("#memory-body")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

describe("MemoryList", () => {
  it("groups entries by category when groupByCategory is true", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const entries = [
      makeEntry({ id: "a", title: "Decision A", category: "decision", pinned: true }),
      makeEntry({ id: "b", title: "Pattern B", category: "pattern" }),
      makeEntry({ id: "c", title: "Context C", category: "context" }),
      makeEntry({ id: "d", title: "Uncat D", category: null }),
    ];

    act(() => {
      root.render(
        <MemoryList
          entries={entries}
          groupByCategory={true}
          onPin={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          editingId={null}
          setEditingId={vi.fn()}
          savingId={null}
        />,
      );
    });

    const html = container.textContent ?? "";
    // Pinned section comes first; section labels are uppercase.
    expect(html).toContain("Pinned");
    expect(html).toContain("Pattern");
    expect(html).toContain("Context");
    expect(html).toContain("Uncategorized");
    expect(html).toContain("Decision A");
    expect(html).toContain("Pattern B");

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders entries flat when groupByCategory is false", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const entries = [
      makeEntry({ id: "a", title: "First" }),
      makeEntry({ id: "b", title: "Second" }),
    ];

    act(() => {
      root.render(
        <MemoryList
          entries={entries}
          groupByCategory={false}
          onPin={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          editingId={null}
          setEditingId={vi.fn()}
          savingId={null}
        />,
      );
    });

    const html = container.textContent ?? "";
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).not.toContain("Pinned");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
