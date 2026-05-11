// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoutineListItem } from "@founderos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cadences, filterCadences } from "./work/Cadences";

let currentSearch = "";

const navigateMock = vi.fn();
const routinesListMock = vi.fn<(companyId: string) => Promise<RoutineListItem[]>>();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/routines", search: currentSearch ? `?${currentSearch}` : "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(currentSearch), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/routines", () => ({
  routinesApi: {
    list: (companyId: string) => routinesListMock(companyId),
    create: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Chief of Staff",
        role: "engineer",
        title: null,
        status: "active",
        reportsTo: null,
        capabilities: null,
        adapterType: "process",
        adapterConfig: {},
        contextMode: "thin",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
        icon: "code",
        metadata: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        urlKey: "chief-of-staff",
        pauseReason: null,
        pausedAt: null,
        permissions: null,
      },
    ]),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "project-1",
        companyId: "company-1",
        urlKey: "project-alpha",
        goalId: null,
        goalIds: [],
        goals: [],
        name: "Project Alpha",
        description: null,
        status: "in_progress",
        leadAgentId: null,
        targetDate: null,
        color: "#22c55e",
        pauseReason: null,
        pausedAt: null,
        archivedAt: null,
        executionWorkspacePolicy: null,
        codebase: null,
        workspaces: [],
        primaryWorkspace: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createCadence(overrides: Partial<RoutineListItem>): RoutineListItem {
  return {
    id: "cadence-1",
    companyId: "company-1",
    projectId: "project-1",
    goalId: null,
    parentIssueId: null,
    title: "Weekly digest",
    description: null,
    assigneeAgentId: "agent-1",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  };
}

async function flush() {
  // Allow React Query promises + state transitions to settle. Must be invoked
  // inside its own act(...) block, not nested in the render's act, otherwise
  // the loading→success transition fires after the outer act closes and the
  // container reads stale.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("filterCadences", () => {
  it("returns only active cadences when status filter is active", () => {
    const cadences = [
      createCadence({ id: "a", status: "active" }),
      createCadence({ id: "b", status: "paused" }),
      createCadence({ id: "c", status: "archived" }),
    ];
    const result = filterCadences(cadences, { status: "active", search: "" });
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });

  it("returns only paused cadences when status filter is paused", () => {
    const cadences = [
      createCadence({ id: "a", status: "active" }),
      createCadence({ id: "b", status: "paused" }),
    ];
    const result = filterCadences(cadences, { status: "paused", search: "" });
    expect(result.map((c) => c.id)).toEqual(["b"]);
  });

  it("returns all cadences regardless of status when filter is 'all'", () => {
    const cadences = [
      createCadence({ id: "a", status: "active" }),
      createCadence({ id: "b", status: "paused" }),
      createCadence({ id: "c", status: "archived" }),
    ];
    const result = filterCadences(cadences, { status: "all", search: "" });
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("narrows by case-insensitive substring search across title and description", () => {
    const cadences = [
      createCadence({ id: "a", title: "Weekly digest", description: null }),
      createCadence({ id: "b", title: "Monthly revenue", description: "stripe pull" }),
      createCadence({ id: "c", title: "Daily standup", description: null }),
    ];
    const result = filterCadences(cadences, { status: "all", search: "STRIPE" });
    expect(result.map((c) => c.id)).toEqual(["b"]);
  });

  it("combines status and search filters", () => {
    const cadences = [
      createCadence({ id: "a", title: "Weekly digest", status: "active" }),
      createCadence({ id: "b", title: "Weekly retro", status: "paused" }),
    ];
    const result = filterCadences(cadences, { status: "active", search: "weekly" });
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("Cadences page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSearch = "";
    navigateMock.mockReset();
    routinesListMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders the Cadences page title and subheading", async () => {
    routinesListMock.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Cadences />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("Cadences");
    expect(container.textContent).toContain("Recurring work your team handles.");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the empty-state message when no cadences are configured", async () => {
    routinesListMock.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Cadences />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });

    expect(container.textContent).toContain("No cadences configured.");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders one cadence card per active cadence with the timeline strip", async () => {
    routinesListMock.mockResolvedValue([
      createCadence({ id: "cadence-1", title: "Weekly digest", status: "active" }),
      createCadence({ id: "cadence-2", title: "Monthly revenue", status: "active" }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Cadences />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });

    const cards = container.querySelectorAll('[data-testid="cadence-card"]');
    expect(cards.length).toBe(2);

    const timelines = container.querySelectorAll('[data-testid="cadence-timeline"]');
    expect(timelines.length).toBe(2);

    // Each timeline has 5 past dots + 1 next dot = 6 status dots.
    const firstTimelineDots = timelines[0]?.querySelectorAll("[data-status]") ?? [];
    expect(firstTimelineDots.length).toBe(6);

    await act(async () => {
      root.unmount();
    });
  });
});
