// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunnerInstallDialog } from "./RunnerInstallDialog";

const mockRunnerApi = vi.hoisted(() => ({
  list: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  status: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("../api/runner", () => ({
  runnerApi: mockRunnerApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the clipboard API — jsdom doesn't ship one.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: vi.fn(async () => undefined) },
});

describe("<RunnerInstallDialog />", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockRunnerApi.list.mockReset();
    mockRunnerApi.issue.mockReset();
    mockRunnerApi.revoke.mockReset();
    toastState.pushToast.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    client.clear();
  });

  function render(open = true) {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <RunnerInstallDialog
            open={open}
            onOpenChange={() => {}}
            companyId="company-1"
            apiBaseUrl="https://founderos.fly.dev"
          />
        </QueryClientProvider>,
      );
    });
  }

  async function flush(predicate?: () => boolean) {
    for (let i = 0; i < 25; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      if (!predicate || predicate()) return;
    }
  }

  it("does not fetch tokens while closed", async () => {
    mockRunnerApi.list.mockResolvedValue({ tokens: [] });
    render(false);
    await flush();
    expect(mockRunnerApi.list).not.toHaveBeenCalled();
  });

  it("fetches tokens when opened and shows the empty state", async () => {
    mockRunnerApi.list.mockResolvedValue({ tokens: [] });
    render(true);
    await flush(() => document.body.textContent?.includes("No tokens yet") ?? false);
    expect(mockRunnerApi.list).toHaveBeenCalledWith("company-1");
    expect(document.body.textContent).toContain("No tokens yet");
  });

  it("renders an existing active token with revoke button", async () => {
    mockRunnerApi.list.mockResolvedValue({
      tokens: [
        {
          tokenId: "tok-active",
          label: "macbook",
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          online: true,
          revokedAt: null,
        },
      ],
    });
    render(true);
    await flush(() => document.body.textContent?.includes("Online") ?? false);
    expect(document.body.textContent).toContain("macbook");
    expect(document.body.textContent).toContain("Online");
    const revoke = document.body.querySelector(
      '[data-testid="runner-token-revoke-tok-active"]',
    );
    expect(revoke).not.toBeNull();
  });

  it("hides the revoke button for revoked tokens", async () => {
    mockRunnerApi.list.mockResolvedValue({
      tokens: [
        {
          tokenId: "tok-dead",
          label: "old-laptop",
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          online: false,
          revokedAt: new Date().toISOString(),
        },
      ],
    });
    render(true);
    await flush(() => document.body.textContent?.includes("Revoked") ?? false);
    expect(document.body.textContent).toContain("old-laptop");
    expect(document.body.textContent).toContain("Revoked");
    expect(
      document.body.querySelector('[data-testid="runner-token-revoke-tok-dead"]'),
    ).toBeNull();
  });

  it("submits the issue form and shows the plaintext token banner", async () => {
    mockRunnerApi.list.mockResolvedValue({ tokens: [] });
    mockRunnerApi.issue.mockResolvedValue({
      tokenId: "new-id",
      token: "fos_abcdefghijklmnopqrstuvwxyzabcdef",
      label: "macbook",
      createdAt: new Date().toISOString(),
    });

    render(true);
    await flush(() => document.body.textContent?.includes("No tokens yet") ?? false);

    const labelInput = document.body.querySelector(
      "#runner-token-label",
    ) as HTMLInputElement;
    expect(labelInput).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(labelInput, "macbook");
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = document.body.querySelector(
      '[data-testid="runner-issue-form"]',
    ) as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush(() =>
      document.body.querySelector('[data-testid="runner-issued-banner"]') !== null,
    );

    expect(mockRunnerApi.issue).toHaveBeenCalledWith("company-1", "macbook");
    const banner = document.body.querySelector(
      '[data-testid="runner-issued-banner"]',
    );
    expect(banner).not.toBeNull();
    expect(document.body.textContent).toContain(
      "fos_abcdefghijklmnopqrstuvwxyzabcdef",
    );
    expect(document.body.textContent).toContain("npm install -g @founderos/runner");
    expect(document.body.textContent).toContain("https://founderos.fly.dev");
  });

  it("calls revoke when the revoke button is clicked", async () => {
    mockRunnerApi.list.mockResolvedValue({
      tokens: [
        {
          tokenId: "tok-1",
          label: "macbook",
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          online: false,
          revokedAt: null,
        },
      ],
    });
    mockRunnerApi.revoke.mockResolvedValue(undefined);

    render(true);
    await flush(
      () =>
        document.body.querySelector(
          '[data-testid="runner-token-revoke-tok-1"]',
        ) !== null,
    );

    const revoke = document.body.querySelector(
      '[data-testid="runner-token-revoke-tok-1"]',
    ) as HTMLButtonElement;
    expect(revoke).not.toBeNull();
    act(() => {
      revoke.click();
    });
    await flush(() => mockRunnerApi.revoke.mock.calls.length > 0);

    expect(mockRunnerApi.revoke).toHaveBeenCalledWith("company-1", "tok-1");
  });
});
