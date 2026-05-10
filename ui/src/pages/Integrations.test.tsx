// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { CompanyProvider } from "../context/CompanyContext";
import { ToastProvider } from "../context/ToastContext";
import { Integrations } from "./Integrations";
import { composioApi } from "../api/composio";

// Mock API modules
vi.mock("../api/integrations", () => ({
  integrationsApi: {
    list: vi.fn(() => Promise.resolve([])),
    test: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("../api/composio", () => ({
  composioApi: {
    status: vi.fn(),
    listConnections: vi.fn(() =>
      Promise.resolve({ connections: [] })
    ),
    connect: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("<Integrations /> — Composio button visibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // CompanyProvider initializes selectedCompanyId from localStorage on mount
    // (see context/CompanyContext.tsx STORAGE_KEY). Pre-seed it so the
    // Integrations page sees a selected company without a real API round-trip.
    localStorage.setItem("founderos.selectedCompanyId", "test-company");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
  });

  function renderIntegrations(composioEnabled: boolean) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    vi.mocked(composioApi.status).mockResolvedValue({
      enabled: composioEnabled,
      configuredApps: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BreadcrumbProvider>
            <CompanyProvider>
              <ToastProvider>
                <Integrations />
              </ToastProvider>
            </CompanyProvider>
          </BreadcrumbProvider>
        </QueryClientProvider>
      );
    });
  }

  it("renders empty-state copy with tool suggestions when no integrations connected", () => {
    renderIntegrations(true);

    // Verify new empty-state copy mentions tools
    const headline = container.querySelector("h1");
    expect(headline?.textContent).toContain("Slack");
    expect(headline?.textContent).toContain("Gmail");
    expect(headline?.textContent).toContain("Notion");
    expect(headline?.textContent).toContain("Google Calendar");
  });

  it("renders Composio primary button when enabled and disconnected", async () => {
    renderIntegrations(true);

    // Page uses async useQuery; wait for IntegrationCard to materialize
    await vi.waitFor(() => {
      const primaryButton = container.querySelector(
        '[data-testid="composio-connect-primary"]'
      );
      expect(primaryButton).not.toBeNull();
      expect(primaryButton?.textContent).toContain("One-click connect");
    });
  });

  it("renders Composio disabled button with explainer when disabled", async () => {
    renderIntegrations(false);

    await vi.waitFor(() => {
      const disabledButton = container.querySelector(
        '[data-testid="composio-connect-disabled"]'
      );
      expect(disabledButton).not.toBeNull();
      expect(disabledButton?.textContent).toContain("One-click connection unavailable");
      expect((disabledButton as HTMLButtonElement | null)?.disabled).toBe(true);

      const explainerText = container.textContent;
      expect(explainerText).toContain("COMPOSIO_API_KEY");
      expect(explainerText).toContain("How to enable");
    });
  });

  it("shows API-key fallback under Advanced disclosure when enabled", () => {
    renderIntegrations(true);

    // Verify Advanced disclosure is present
    const advancedSummary = Array.from(
      container.querySelectorAll("summary")
    ).find((el) => el.textContent?.includes("Advanced"));
    expect(advancedSummary).not.toBeNull();

    // Verify API key fallback button text is in the document
    const apiKeyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Connect with API key")
    );
    expect(apiKeyButton).not.toBeNull();
  });

  it("shows API-key fallback under How to enable disclosure when disabled", () => {
    renderIntegrations(false);

    // Verify "How to enable" disclosure is present
    const howToEnableSummary = Array.from(
      container.querySelectorAll("summary")
    ).find((el) => el.textContent?.includes("How to enable"));
    expect(howToEnableSummary).not.toBeNull();

    // Verify API key fallback button text is in the document
    const apiKeyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Connect with API key")
    );
    expect(apiKeyButton).not.toBeNull();
  });
});
