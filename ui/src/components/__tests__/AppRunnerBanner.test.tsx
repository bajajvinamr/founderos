// @vitest-environment jsdom

/**
 * Audit P0.4 (supplementary) — AppRunnerBanner unit tests.
 *
 * Acceptance:
 *   - Hidden when at least one runner token is online.
 *   - Renders the never-connected banner when no token has ever pinged.
 *   - Renders the went-offline banner when a token has lastSeenAt within
 *     the recent window but no token is currently online.
 *   - "Get setup instructions" link points at the runner-setup surface.
 *   - Dismiss button hides the banner and writes a localStorage record.
 *   - Banner re-appears once the 4-hour TTL has expired (simulated via
 *     stale localStorage timestamp).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRunnerBanner, classifyAppRunnerState } from "../AppRunnerBanner";
import type { RunnerTokenSummary } from "../../api/runner";

const mockRunnerApi = vi.hoisted(() => ({
  status: vi.fn(),
}));

vi.mock("../../api/runner", () => ({
  runnerApi: mockRunnerApi,
}));

// Provide minimal stand-ins for the contexts the banner depends on.
// The banner accepts companyIdOverride / userIdOverride for tests, but
// the underlying hooks still resolve via context, so we mock them out
// to avoid wiring a full provider tree.
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

// React 19 act() environment hint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TEST_USER_ID = "user-1";
const DISMISS_KEY = `runner-banner-dismissed-${TEST_USER_ID}`;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function token(over: Partial<RunnerTokenSummary> = {}): RunnerTokenSummary {
  return {
    tokenId: "tok-1",
    label: "macbook",
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    online: false,
    expiresAt: null,
    expiresInDays: null,
    ...over,
  };
}

describe("classifyAppRunnerState", () => {
  it("returns hidden when undefined (still loading)", () => {
    expect(classifyAppRunnerState(undefined)).toEqual({ kind: "hidden" });
  });

  it("returns hidden when at least one token is online", () => {
    expect(
      classifyAppRunnerState([token({ online: true, lastSeenAt: new Date().toISOString() })]),
    ).toEqual({ kind: "hidden" });
  });

  it("returns never-connected when token list is empty", () => {
    expect(classifyAppRunnerState([])).toEqual({ kind: "never-connected" });
  });

  it("returns never-connected when no token has ever pinged", () => {
    expect(
      classifyAppRunnerState([token({ lastSeenAt: null }), token({ tokenId: "t2", lastSeenAt: null })]),
    ).toEqual({ kind: "never-connected" });
  });

  it("returns went-offline when lastSeenAt is within the recent window", () => {
    const now = Date.now();
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    expect(
      classifyAppRunnerState([token({ online: false, lastSeenAt: fiveMinAgo })], now),
    ).toEqual({ kind: "went-offline", lastSeenAt: fiveMinAgo });
  });

  it("returns hidden when lastSeenAt is older than the recent window", () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    expect(
      classifyAppRunnerState([token({ online: false, lastSeenAt: oneHourAgo })], now),
    ).toEqual({ kind: "hidden" });
  });
});

describe("<AppRunnerBanner />", () => {
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
          <AppRunnerBanner />
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

  it("renders nothing while the query is in flight", () => {
    mockRunnerApi.status.mockReturnValue(new Promise(() => {}));
    render();
    expect(container.querySelector('[data-testid="app-runner-banner"]')).toBeNull();
  });

  it("renders nothing when at least one token is online", async () => {
    mockRunnerApi.status.mockResolvedValue({
      tokens: [token({ online: true, lastSeenAt: new Date().toISOString() })],
    });
    render();
    // Give the query a few ticks to resolve.
    await flushQuery(() => mockRunnerApi.status.mock.calls.length > 0);
    await flushQuery(() => false); // drain microtasks
    expect(container.querySelector('[data-testid="app-runner-banner"]')).toBeNull();
  });

  it("renders the never-connected banner when no token has ever pinged", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="app-runner-banner"]') !== null,
    );
    const banner = container.querySelector('[data-testid="app-runner-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector('[data-testid="app-runner-banner-message-never"]')).not.toBeNull();
    const cta = container.querySelector(
      '[data-testid="app-runner-banner-cta"]',
    ) as HTMLAnchorElement | null;
    // 2026-05-18 (G8) — CTA href now carries `install-runner=1` so the
    // Agents page auto-opens RunnerInstallDialog on mount (token issuance
    // + install snippet in one click rather than landing the founder on
    // the team page with no obvious next step).
    expect(cta?.getAttribute("href")).toBe("/agents/all?install-runner=1");
    expect(cta?.textContent).toContain("Get setup instructions");
  });

  it("renders the went-offline banner when the runner WAS connected but is now offline", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockRunnerApi.status.mockResolvedValue({
      tokens: [token({ online: false, lastSeenAt: fiveMinAgo })],
    });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="app-runner-banner"]') !== null,
    );
    expect(
      container.querySelector('[data-testid="app-runner-banner-message-offline"]'),
    ).not.toBeNull();
    const cta = container.querySelector(
      '[data-testid="app-runner-banner-cta"]',
    ) as HTMLAnchorElement | null;
    expect(cta?.textContent).toContain("Reconnect");
  });

  it("hides the banner and writes a localStorage record when dismissed", async () => {
    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="app-runner-banner"]') !== null,
    );
    const dismissButton = container.querySelector(
      '[data-testid="app-runner-banner-dismiss"]',
    ) as HTMLButtonElement | null;
    expect(dismissButton).not.toBeNull();

    act(() => {
      dismissButton!.click();
    });

    expect(container.querySelector('[data-testid="app-runner-banner"]')).toBeNull();
    const stored = window.localStorage.getItem(DISMISS_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string);
    expect(typeof parsed.dismissedAt).toBe("number");
  });

  it("re-renders the banner once the 4h dismissal TTL has elapsed", async () => {
    // Pre-seed an EXPIRED dismissal record (5h old).
    const expiredAt = Date.now() - (FOUR_HOURS_MS + 60_000);
    window.localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ dismissedAt: expiredAt }),
    );

    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    await flushQuery(
      () => container.querySelector('[data-testid="app-runner-banner"]') !== null,
    );
    expect(container.querySelector('[data-testid="app-runner-banner"]')).not.toBeNull();
    // The expired record should have been cleared by readDismissal.
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull();
  });

  it("keeps the banner hidden while a fresh dismissal record is present", async () => {
    // Pre-seed a fresh dismissal record (1 minute old).
    window.localStorage.setItem(
      DISMISS_KEY,
      JSON.stringify({ dismissedAt: Date.now() - 60_000 }),
    );

    mockRunnerApi.status.mockResolvedValue({ tokens: [] });
    render();
    // Even after the network query resolves to "missing tokens," the
    // dismissal flag must keep the banner hidden.
    await flushQuery(() => mockRunnerApi.status.mock.calls.length > 0);
    await flushQuery(() => false);
    expect(container.querySelector('[data-testid="app-runner-banner"]')).toBeNull();
  });
});
