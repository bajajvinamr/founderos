// @vitest-environment jsdom

/**
 * P3 Wave 1 — Today page tests.
 *
 * Source: 06-engineering-handoff.md §2.3 + 02-calm-surfaces.md §A.
 *
 * Asserts:
 *   - The decision lede renders one row per pending approval.
 *   - Cold-start (no decisions + no brief) renders the quiet empty-state
 *     copy + clickable example, NOT a CTA wall (§A.6 + §F).
 *   - Greeting is "Hi, {firstName}." all day every day (F-15 collapse).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Today } from "./Today";
import { ApiError } from "../api/client";
import type { Approval } from "@founderos/shared";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockDailyBriefsApi = vi.hoisted(() => ({
  list: vi.fn(),
  // L2-C05: `/today` now uses GET .../daily-briefs/latest via dailyBriefsApi.latest.
  // The component (and DailyBriefView) call this method; 404 surfaces as the
  // empty state and is mocked via rejectedValue with an ApiError.
  latest: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/daily-briefs", () => ({
  dailyBriefsApi: mockDailyBriefsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string }) => (
    <a href={String(to)} className={className} {...rest}>
      {children}
    </a>
  ),
}));

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "appr-" + Math.random().toString(36).slice(2),
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { title: over.payload?.title ?? "Decision row" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface Mount {
  container: HTMLElement;
  root: Root;
  queryClient: QueryClient;
}

let mounts: Mount[] = [];

function mountToday(): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Today />
      </QueryClientProvider>,
    );
  });
  const mount: Mount = { container, root, queryClient };
  mounts.push(mount);
  return mount;
}

beforeEach(() => {
  mockApprovalsApi.list.mockResolvedValue([]);
  mockDailyBriefsApi.list.mockResolvedValue({ briefs: [], meta: { limit: 1, offset: 0, count: 0 } });
  // Default: no brief → 404 ApiError surfaces as the empty state.
  mockDailyBriefsApi.latest.mockRejectedValue(
    new ApiError("No daily brief found", 404, null),
  );
  mockAuthApi.getSession.mockResolvedValue({
    user: { id: "u-1", email: "vinamr@example.com", name: "Vinamr Bajaj" },
  });
});

afterEach(() => {
  for (const mount of mounts) {
    act(() => mount.root.unmount());
    mount.container.remove();
    mount.queryClient.clear();
  }
  mounts = [];
  vi.clearAllMocks();
});

describe("Today — Wave 1 page", () => {
  it("renders the decision lede with one row per pending approval", async () => {
    mockApprovalsApi.list.mockResolvedValue([
      approval({ payload: { title: "Stripe webhook idempotency — needs your sign-off" } }),
      approval({ payload: { title: "Acme contract pricing is missing" } }),
      approval({ payload: { title: "Growth flagged a churn risk on Helio" } }),
    ]);

    const { container } = mountToday();

    // Wait for the approvals query to resolve.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Greeting is firstName-only, all day every day.
    const greeting = container.querySelector('[data-testid="today-greeting"]');
    expect(greeting?.textContent).toBe("Hi, Vinamr.");

    const subheading = container.querySelector('[data-testid="today-subheading"]');
    expect(subheading?.textContent).toBe("3 things need your call today.");

    // 3 decision rows.
    const decisionSection = container.querySelector('section[aria-label="Decisions awaiting your call"]');
    expect(decisionSection).toBeTruthy();
    const decisionRows = decisionSection?.querySelectorAll("a");
    expect(decisionRows?.length).toBe(3);
    expect(decisionRows?.[0]?.textContent).toContain("Stripe webhook idempotency");
  });

  it("cold-start (no decisions + no brief) renders the quiet empty-state copy", async () => {
    mockApprovalsApi.list.mockResolvedValue([]);
    mockDailyBriefsApi.list.mockResolvedValue({ briefs: [], meta: { limit: 1, offset: 0, count: 0 } });

    const { container } = mountToday();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const subheading = container.querySelector('[data-testid="today-subheading"]');
    expect(subheading?.textContent).toBe("Nothing's waiting on you.");

    // Cold-start hint is present, with the F-05-corrected example sentence.
    const text = container.textContent ?? "";
    expect(text).toContain("Draft our company charter.");

    // Empty state is a single line — no CTA wall (§4.3 + §A.6).
    // Specifically, the decision section is NOT rendered at all.
    expect(container.querySelector('section[aria-label="Decisions awaiting your call"]')).toBeNull();
  });
});
