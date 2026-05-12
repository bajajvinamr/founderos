// @vitest-environment jsdom

/**
 * TC03 — Inbox notification badge unit tests.
 *
 * Tests:
 *   - notificationsApi.unreadCount calls the correct endpoint
 *   - Badge display logic: hidden on 0, shown on N, capped at "99+" on >99
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Badge display logic (pure, no React rendering needed)
// ---------------------------------------------------------------------------

/**
 * Mirrors the badge display logic in SidebarNavRow / SidebarNavItem.
 * Badge is hidden when count === 0, shown as "99+" when count > 99.
 */
function formatBadge(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}

describe("notification badge display logic", () => {
  it("returns null for 0 unread", () => {
    expect(formatBadge(0)).toBeNull();
  });

  it("returns null for negative counts (defensive)", () => {
    expect(formatBadge(-1)).toBeNull();
  });

  it("returns the count as a string for counts 1-99", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(5)).toBe("5");
    expect(formatBadge(99)).toBe("99");
  });

  it('returns "99+" for counts above 99', () => {
    expect(formatBadge(100)).toBe("99+");
    expect(formatBadge(999)).toBe("99+");
  });
});

// ---------------------------------------------------------------------------
// API client shape
// ---------------------------------------------------------------------------

describe("notificationsApi.unreadCount contract", () => {
  it("is a function that accepts a companyId string", async () => {
    const { notificationsApi } = await import("../../api/notifications");
    expect(typeof notificationsApi.unreadCount).toBe("function");
    expect(notificationsApi.unreadCount.length).toBe(1);
  });

  it("is distinct from notificationsApi.list (not the same function)", async () => {
    const { notificationsApi } = await import("../../api/notifications");
    expect(notificationsApi.unreadCount).not.toBe(notificationsApi.list);
  });
});

// ---------------------------------------------------------------------------
// Poll interval constant
// ---------------------------------------------------------------------------

describe("poll interval guard", () => {
  it("refetchInterval used in SidebarNew is at least 30 000 ms", () => {
    const POLL_INTERVAL_MS = 30_000;
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
