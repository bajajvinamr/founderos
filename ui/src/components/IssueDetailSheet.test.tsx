// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@founderos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchState = { value: "" };
const setSearchParamsMock = vi.fn((next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams)) => {
  if (typeof next === "function") {
    const fn = next as (prev: URLSearchParams) => URLSearchParams;
    searchState.value = fn(new URLSearchParams(searchState.value)).toString();
  } else {
    searchState.value = next.toString();
  }
});

vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams(searchState.value), setSearchParamsMock],
  useLocation: () => ({ pathname: "/issues", search: searchState.value ? `?${searchState.value}` : "", hash: "" }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));

const issuesGetMock = vi.fn<(id: string) => Promise<Issue | undefined>>();
const issuesUpdateMock = vi.fn<(id: string, data: Record<string, unknown>) => Promise<undefined>>(async () => undefined);

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: (id: string) => issuesGetMock(id),
    update: (id: string, data: Record<string, unknown>) => issuesUpdateMock(id, data),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// Stub heavy/Radix children with simple shells so render is deterministic.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetContent: ({
    children,
    showCloseButton: _showCloseButton,
    side: _side,
    ...rest
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
    side?: string;
  } & Record<string, unknown>) => (
    <div {...(rest as Record<string, unknown>)}>{children}</div>
  ),
  SheetHeader: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...(rest as Record<string, unknown>)}>{children}</div>
  ),
  SheetTitle: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
    <h2 {...(rest as Record<string, unknown>)}>{children}</h2>
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>status:{status}</span>,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>priority:{priority}</span>,
}));

// Import LAST so the mocks above are in place.
import { IssueDetailSheet, ISSUE_DETAIL_SHEET_PARAM } from "./IssueDetailSheet";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: "issue-id-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Auth round-trip",
    description: "Two-tab session test broken on Safari ITP.",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 117,
    identifier: "PAP-117",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-10T00:00:00Z"),
    updatedAt: new Date("2026-05-10T00:00:00Z"),
  } as unknown as Issue;
  return { ...base, ...overrides };
}

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  return { container, root, queryClient };
}

async function flush(iterations = 5) {
  // Pump microtasks + macrotasks a few times to let React Query queries settle.
  for (let i = 0; i < iterations; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("IssueDetailSheet", () => {
  beforeEach(() => {
    searchState.value = "";
    setSearchParamsMock.mockClear();
    issuesGetMock.mockReset();
    issuesUpdateMock.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens with row data when ?row= is present and fetches the issue", async () => {
    searchState.value = `${ISSUE_DETAIL_SHEET_PARAM}=PAP-117`;
    issuesGetMock.mockResolvedValue(makeIssue());

    const { container, root } = renderWithClient(<IssueDetailSheet />);
    await flush();

    expect(issuesGetMock).toHaveBeenCalledWith("PAP-117");
    expect(container.querySelector('[data-testid="sheet-root"]')).not.toBeNull();
    expect(container.textContent).toContain("PAP-117");
    expect(container.textContent).toContain("Auth round-trip");
    // "Open full page →" affordance present
    expect(container.querySelector('[data-testid="issue-detail-sheet-full-page"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("closes on Escape and drops the ?row= search param", async () => {
    searchState.value = `${ISSUE_DETAIL_SHEET_PARAM}=PAP-117&q=foo`;
    issuesGetMock.mockResolvedValue(makeIssue());

    const { root } = renderWithClient(<IssueDetailSheet />);
    await flush();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();

    expect(setSearchParamsMock).toHaveBeenCalled();
    const callArg = setSearchParamsMock.mock.calls[0]?.[0];
    expect(callArg).toBeInstanceOf(URLSearchParams);
    const submitted = callArg as URLSearchParams;
    expect(submitted.has(ISSUE_DETAIL_SHEET_PARAM)).toBe(false);
    // Other params survive.
    expect(submitted.get("q")).toBe("foo");

    act(() => root.unmount());
  });

  it("does not fetch and does not render when ?row= is absent (URL is the source of truth)", async () => {
    searchState.value = "";
    issuesGetMock.mockResolvedValue(makeIssue());

    const { container, root } = renderWithClient(<IssueDetailSheet />);
    await flush();

    expect(issuesGetMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="sheet-root"]')).toBeNull();

    act(() => root.unmount());
  });
});
