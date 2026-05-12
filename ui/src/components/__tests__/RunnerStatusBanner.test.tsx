// @vitest-environment jsdom

/**
 * TC02 — RunnerStatusBanner unit tests.
 *
 * Covers the three acceptance states:
 *   1. Runner is online           → banner returns null (hidden).
 *   2. Runner offline + configured → banner visible with offline copy.
 *   3. Never connected + configured → banner visible with never-connected copy.
 *
 * Also tests dismissal (writes localStorage, hides banner) and the
 * pure-function classifier separately.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunnerStatusBanner, classifyRunnerBannerState } from "../RunnerStatusBanner";
import type { RunnerTokenSummary } from "../../api/runner";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockRunnerApi = vi.hoisted(() => ({
  status: vi.fn(),
}));

vi.mock("../../api/runner", () => ({
  runnerApi: mockRunnerApi,
}));

// Minimal stand-ins so the banner can mount without a full provider tree.
vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [],
    selectedCompany: null,
    loading: false,
    selectionSource: "default",
    setSelectedCompanyId: () => {},
  }),
}));

vi.mock("../../context/SupabaseAuthContext", () => ({
  useSupabaseAuth: () => ({
    user: { id: "user-1" } as { id: string },
    session: null,
    loading: false,
  }),
}));

// RunnerInstallDialog is a heavy modal — stub it out for unit tests.
vi.mock("../RunnerInstallDialog", () => ({
  RunnerInstallDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="runner-install-dialog-stub" /> : null,
}));

// React 19 act() hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER_ID = "user-1";
const DISMISS_KEY = `founderos_runner_banner_dismissed_at_${TEST_USER_ID}`;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function token(over: Partial<RunnerTokenSummary> = {}): RunnerTokenSummary {
  return {
    tokenId: "tok-1",
    label: "laptop",
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    online: false,
    expiresAt: null,
    expiresInDays: null,
    ...over,
  };
}

// ── Pure classifier ───────────────────────────────────────────────────────────

describe("classifyRunnerBannerState", () => {
  it("returns hidden when tokens are undefined (still loading)", () => {
    expect(classifyRunnerBannerState(undefined)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when at least one token is online", () => {
    expect(
      classifyRunnerBannerState([token({ online: true, lastSeenAt: new Date().toISOString() })]),
    ).toEqual({ kind: "hidden" });
  });

  it("returns never-connected when the token list is empty", () => {
    expect(classifyRunnerBannerState([])).toEqual({ kind: "never-connected" });
  });

  it("returns never-connected when no token has ever pinged (all lastSeenAt null)", () => {
    expect(
      classifyRunnerBannerState([token({ lastSeenAt: null }), token({ tokenId: "t2", lastSeenAt: null })]),
    ).toEqual({ kind: "never-connected" });
  });

  it("returns offline when lastSeenAt is within the recent window", () => {
    const now = Date.now();
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const result = classifyRunnerBannerState([token({ online: false, lastSeenAt: fiveMinAgo })], now);
    expect(result).toEqual({ kind: "offline", lastSeenAt: fiveMinAgo });
  });

  it("returns hidden when lastSeenAt is older than the recent window", () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    expect(
      classifyRunnerBannerState([token({ online: false, lastSeenAt: twoHoursAgo })], now),
    ).toEqual({ kind: "hidden" });
  });
});

// ── Component ─────────────────────────────────────────────────────────────────

describe("<RunnerStatusBanner />", () => {
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
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    window.localStorage.clear();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RunnerStatusBanner />
        </QueryClientProvider>,
      );
    });
  }

  async function flushQuery(predicate: () => boolean) {
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      if (predicate()) return;
    }
  }

  // ── State 1: online → null ──────────────────────────────────────────────────

  it("STATE 1: renders null when at least one runner token is online", async () => {
    mockRunnerApi.status.mockResolvedValue({
      tokens: [token({ online: true, lastSeenAt: new Date().toISOString() })],
    });
    render();
    await flushQuery(() => mockRunnerApi.status.mock.calls.length > 0);
    await flushQuery(() => false); // drain microtasks
    expect(container.querySelector('[data-testid="runner-status-banner"]')).toBeNull();
  });

  it("renders nothing while the initial query is in-flight", () => {
    mockRunnerApi.status.mockReturnValue(new Promise(() => {}));
    render();
    expect(container.querySelector('[data-testid="runner-status-banner"]')).toBeNull();
  });

  // ── State 2: offline + configured → banner visible ─────────────────────────

  it("STATE 2: shows offline banner when runner WAS connected but is now offline (configured)", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockRunnerApi.status.mockResolvedValue({
      tokens: [token({ online: false, lastSeenAt: fiveMinAgo })],
    });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="runner-status-banner"]') !== null,
    );

    const banner = container.querySelector('[data-testid="runner-status-banner"]');
    expect(banner).not.toBeNull();
    // Accessible alert role
    expect(banner?.getAttribute("role")).toBe("alert");
    // Offline message
    expect(
      container.querySelector('[data-testid="runner-status-banner-message-offline"]'),
    ).not.toBeNull();
    // CTA button present and keyboard-focusable (it's a <button>)
    const cta = container.querySelector('[data-testid="runner-status-banner-cta"]') as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    expect(cta?.tagName).toBe("BUTTON");
    expect(cta?.textContent?.trim()).toBe("Get install command");
  });

  it("clicking the CTA button opens RunnerInstallDialog", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockRunnerApi.status.mockResolvedValue({
      tokens: [token({ online: false, lastSeenAt: fiveMinAgo })],
    });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="runner-status-banner"]') !== null,
    );

    const cta = container.querySelector('[data-testid="runner-status-banner-cta"]') as HTMLButtonElement;
    expect(container.querySelector('[data-testid="runner-install-dialog-stub"]')).toBeNull();

    act(() => { cta.click(); });

    expect(container.querySelector('[data-testid="runner-install-dialog-stub"]')).not.toBeNull();
  });

  // ── State 3: never_seen + configured → banner with never-connected copy ─────

  it("STATE 3: shows never-connected banner when no runner token has ever pinged (configured)", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="runner-status-banner"]') !== null,
    );

    const banner = container.querySelector('[data-testid="runner-status-banner"]');
    expect(banner).not.toBeNull();
    // Never-connected copy
    expect(
      container.querySelector('[data-testid="runner-status-banner-message-never"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="runner-status-banner-message-offline"]'),
    ).toBeNull();
    // CTA still present
    expect(
      container.querySelector('[data-testid="runner-status-banner-cta"]'),
    ).not.toBeNull();
  });

  // ── Dismissal ──────────────────────────────────────────────────────────────

  it("clicking Dismiss hides the banner and writes a localStorage record", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="runner-status-banner"]') !== null,
    );

    const dismissButton = container.querySelector(
      '[data-testid="runner-status-banner-dismiss"]',
    ) as HTMLButtonElement | null;
    expect(dismissButton).not.toBeNull();

    act(() => { dismissButton!.click(); });

    expect(container.querySelector('[data-testid="runner-status-banner"]')).toBeNull();
    const stored = window.localStorage.getItem(DISMISS_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string);
    expect(typeof parsed.dismissedAt).toBe("number");
  });

  it("keeps the banner hidden while a fresh (< 24 h) dismissal record is present", async () => {
    window.localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ dismissedAt: Date.now() - 60_000 }),
    );
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(() => mockRunnerApi.status.mock.calls.length > 0);
    await flushQuery(() => false);
    expect(container.querySelector('[data-testid="runner-status-banner"]')).toBeNull();
  });

  it("re-shows the banner when the dismissal record has expired (> 24 h)", async () => {
    const expiredAt = Date.now() - (TWENTY_FOUR_HOURS_MS + 60_000);
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify({ dismissedAt: expiredAt }));

    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="runner-status-banner"]') !== null,
    );
    expect(container.querySelector('[data-testid="runner-status-banner"]')).not.toBeNull();
    // Expired record should be cleared from localStorage.
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull();
  });
});
