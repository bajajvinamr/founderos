// @vitest-environment jsdom

/**
 * Audit P0.2 — NotificationBell unit tests.
 *
 * - 0 unread → no badge
 * - 3 unread → badge renders "3"
 * - popover opens on click and renders the list
 */

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";
import type { NotificationRow } from "../api/notifications";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  selectedCompany: { issuePrefix: "ACM" } as { issuePrefix: string } | null,
}));

const mockNotificationsApi = vi.hoisted(() => ({
  list: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../api/notifications", () => ({
  notificationsApi: mockNotificationsApi,
}));

// Inline stub for the router Link — matches the real export shape.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Stub the Popover so its content renders inline (no portal, no animation
// gating) — keeps the test deterministic on jsdom which doesn't implement
// pointer events the way Radix expects. The trigger toggles `open` via
// `onOpenChange` so click-to-open works in tests; PopoverContent only
// renders when open (matches Radix behavior closely enough for tests).
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  type RootProps = {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  };
  const Ctx = React.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  }>({ open: false, setOpen: () => {} });
  return {
    Popover: ({ open, onOpenChange, children }: RootProps) => (
      <Ctx.Provider
        value={{ open: !!open, setOpen: (v) => onOpenChange?.(v) }}
      >
        <div data-popover-open={open ? "true" : "false"}>{children}</div>
      </Ctx.Provider>
    ),
    PopoverTrigger: ({ children }: { asChild?: boolean; children: ReactNode }) => {
      const { open, setOpen } = React.useContext(Ctx);
      const child = React.Children.only(children) as React.ReactElement<{
        onClick?: (e: React.MouseEvent) => void;
      }>;
      const onClick = (e: React.MouseEvent) => {
        child.props.onClick?.(e);
        setOpen(!open);
      };
      return React.cloneElement(child, { onClick });
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(Ctx);
      if (!open) return null;
      return <div data-testid="popover-content">{children}</div>;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

function makeRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notif-1",
    companyId: "company-1",
    userId: "user-1",
    kind: "approval_needed",
    title: "Approve workflow run",
    body: null,
    refKind: "approval",
    refId: "appr-1",
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("NotificationBell", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    companyState.selectedCompany = { issuePrefix: "ACM" };
    mockNotificationsApi.list.mockReset();
    mockNotificationsApi.unreadCount.mockReset();
    mockNotificationsApi.markRead.mockReset();
    mockNotificationsApi.markAllRead.mockReset();
    mockNotificationsApi.list.mockResolvedValue({ notifications: [] });
    mockNotificationsApi.unreadCount.mockResolvedValue({ unreadCount: 0 });
    mockNotificationsApi.markRead.mockResolvedValue({ ok: true });
    mockNotificationsApi.markAllRead.mockResolvedValue({ updatedCount: 0 });
  });

  afterEach(() => {
    container.remove();
  });

  it("hides the badge when unreadCount is 0", async () => {
    const { root } = renderWithQueryClient(<NotificationBell />, container);
    await waitForAssertion(() => {
      expect(mockNotificationsApi.unreadCount).toHaveBeenCalledWith("company-1");
    });
    await flush();

    const badge = container.querySelector('[data-testid="notification-bell-badge"]');
    expect(badge).toBeNull();

    // Bell trigger itself is rendered.
    const bell = container.querySelector('[data-testid="notification-bell"]');
    expect(bell).not.toBeNull();
    expect(bell?.getAttribute("aria-label")).toBe("Notifications");

    act(() => root.unmount());
  });

  it("renders the badge with the unread count when > 0", async () => {
    mockNotificationsApi.unreadCount.mockResolvedValue({ unreadCount: 3 });
    const { root } = renderWithQueryClient(<NotificationBell />, container);

    await waitForAssertion(() => {
      const badge = container.querySelector(
        '[data-testid="notification-bell-badge"]',
      );
      expect(badge?.textContent).toBe("3");
    });

    const bell = container.querySelector('[data-testid="notification-bell"]');
    expect(bell?.getAttribute("aria-label")).toBe("Notifications, 3 unread");

    act(() => root.unmount());
  });

  it("caps the badge at 99+", async () => {
    mockNotificationsApi.unreadCount.mockResolvedValue({ unreadCount: 250 });
    const { root } = renderWithQueryClient(<NotificationBell />, container);

    await waitForAssertion(() => {
      const badge = container.querySelector(
        '[data-testid="notification-bell-badge"]',
      );
      expect(badge?.textContent).toBe("99+");
    });

    act(() => root.unmount());
  });

  it("opens the popover on click and lists notifications", async () => {
    const rows: NotificationRow[] = [
      makeRow({ id: "n-1", title: "Approve A", refId: "appr-A" }),
      makeRow({
        id: "n-2",
        title: "Approve B",
        refId: "appr-B",
        readAt: new Date().toISOString(),
      }),
    ];
    mockNotificationsApi.unreadCount.mockResolvedValue({ unreadCount: 1 });
    mockNotificationsApi.list.mockResolvedValue({ notifications: rows });

    const { root } = renderWithQueryClient(<NotificationBell />, container);

    // Initial render — count loads, list does NOT (popover closed).
    await waitForAssertion(() => {
      expect(mockNotificationsApi.unreadCount).toHaveBeenCalled();
    });
    expect(mockNotificationsApi.list).not.toHaveBeenCalled();

    // Click the bell to open the popover.
    const bell = container.querySelector(
      '[data-testid="notification-bell"]',
    ) as HTMLButtonElement;
    expect(bell).not.toBeNull();
    act(() => {
      bell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // List query fires and rows render.
    await waitForAssertion(() => {
      expect(mockNotificationsApi.list).toHaveBeenCalledWith("company-1", {
        limit: 20,
      });
    });
    await waitForAssertion(() => {
      expect(
        container.querySelector('[data-testid="notification-row-n-1"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="notification-row-n-2"]'),
      ).not.toBeNull();
    });

    // Approval rows link to /:companyPrefix/approvals/:id.
    const link = container.querySelector(
      '[data-testid="notification-row-n-1"]',
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/ACM/approvals/appr-A");

    act(() => root.unmount());
  });

  it("renders nothing when no company is selected", async () => {
    companyState.selectedCompanyId = null;
    companyState.selectedCompany = null;
    const { root } = renderWithQueryClient(<NotificationBell />, container);
    await flush();

    expect(
      container.querySelector('[data-testid="notification-bell"]'),
    ).toBeNull();
    expect(mockNotificationsApi.unreadCount).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
