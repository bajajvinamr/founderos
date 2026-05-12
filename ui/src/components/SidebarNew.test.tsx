// @vitest-environment jsdom

/**
 * P3 Wave 1 — SidebarNew tests.
 *
 * Source: 06-engineering-handoff.md §2.3.
 * Asserts:
 *   - All 5 sections render (Today / Work / Team / Library / Settings)
 *   - Today is the ONLY section that shows a count badge in chrome
 *     (Designer A §7.4 — chrome counts compete with AskBar)
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarNew } from "./SidebarNew";
import type { Approval } from "@founderos/shared";

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className }: { to: string; children: ReactNode | ((args: { isActive: boolean }) => ReactNode); className?: string | ((args: { isActive: boolean }) => string) }) => {
    const isActive = false;
    const resolvedClass = typeof className === "function" ? className({ isActive }) : className;
    const resolvedChildren = typeof children === "function" ? children({ isActive }) : children;
    return (
      <a href={String(to)} className={resolvedClass}>
        {resolvedChildren}
      </a>
    );
  },
  useNavigate: () => vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: { id: "company-1", name: "Test Co", brandColor: "#123456", issuePrefix: "TST" },
}));

const themeState = vi.hoisted(() => ({
  theme: "dark" as "dark" | "light",
  toggleTheme: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

const mockNotificationsApi = vi.hoisted(() => ({
  unreadCount: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => themeState,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/notifications", () => ({
  notificationsApi: mockNotificationsApi,
}));

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "appr-" + Math.random().toString(36).slice(2),
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
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

function mountSidebar(): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarNew />
      </QueryClientProvider>,
    );
  });

  const mount: Mount = { container, root, queryClient };
  mounts.push(mount);
  return mount;
}

beforeEach(() => {
  mockApprovalsApi.list.mockResolvedValue([]);
  mockAuthApi.getSession.mockResolvedValue({ user: { id: "u-1", email: "v@example.com", name: "Vinamr" } });
  mockNotificationsApi.unreadCount.mockResolvedValue({ unreadCount: 0 });
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

describe("SidebarNew — 5-section IA", () => {
  it("renders exactly 5 nav rows: Today, Work, Team, Library, Settings", () => {
    const { container } = mountSidebar();
    const navRows = container.querySelectorAll('nav[aria-label="Primary navigation"] a');
    expect(navRows.length).toBe(5);
    const labels = Array.from(navRows).map((a) => a.textContent?.trim());
    // Note: labels include the badge text on Today (just "Today" + count)
    expect(labels[0]?.startsWith("Today")).toBe(true);
    expect(labels[1]).toBe("Work");
    expect(labels[2]).toBe("Team");
    expect(labels[3]).toBe("Library");
    expect(labels[4]).toBe("Settings");
  });

  it("renders the Today badge only when pending approvals exist (chrome-counts rule §7.4)", async () => {
    mockApprovalsApi.list.mockResolvedValue([
      makeApproval({ status: "pending" }),
      makeApproval({ status: "pending" }),
      makeApproval({ status: "revision_requested" }),
    ]);
    const { container } = mountSidebar();

    // Wait for the approvals query to resolve.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const navRows = container.querySelectorAll('nav[aria-label="Primary navigation"] a');
    const todayRow = navRows[0];
    const otherRows = Array.from(navRows).slice(1);

    expect(todayRow?.textContent).toContain("3");

    // Other sections must NOT show any numeric badges.
    for (const row of otherRows) {
      // Strip the label text; if any digits remain it's a stray badge.
      const labelText = row.textContent ?? "";
      const digits = labelText.match(/\d+/);
      expect(digits, `row "${labelText.trim()}" should not show a numeric badge`).toBeNull();
    }
  });
});
