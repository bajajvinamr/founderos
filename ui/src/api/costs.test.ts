// @vitest-environment jsdom

/**
 * Contract test for `costsApi`.
 *
 * Costs is a read-heavy surface (10 GET endpoints, all date-window scoped). A
 * silently-changed path or query-param shape regresses the entire Costs page
 * with no typecheck signal. This test pins the URL contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  supabase: {},
}));

import { costsApi } from "./costs";

interface CapturedRequest {
  url: string;
  method: string;
}

function captureFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  lastRequest: () => CapturedRequest;
} {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method ?? "GET" });
    return {
      ok: true,
      status: 200,
      json: async () => ([]),
    } as Response;
  });
  return {
    fetchMock,
    lastRequest: () => {
      if (calls.length === 0) throw new Error("fetch was never called");
      return calls[calls.length - 1]!;
    },
  };
}

describe("costsApi contract", () => {
  let restoreFetch: () => void;
  let lastRequest: () => CapturedRequest;

  beforeEach(() => {
    const { fetchMock, lastRequest: getLast } = captureFetch();
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    lastRequest = getLast;
  });

  afterEach(() => {
    restoreFetch();
    vi.clearAllMocks();
  });

  it("summary GET /api/companies/:id/costs/summary", async () => {
    await costsApi.summary("company-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/costs/summary");
    expect(req.method).toBe("GET");
  });

  it("summary forwards from/to date params", async () => {
    await costsApi.summary("company-1", "2026-01-01", "2026-01-31");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/summary?from=2026-01-01&to=2026-01-31",
    );
  });

  it("byAgent GET /api/companies/:id/costs/by-agent (kebab-case)", async () => {
    await costsApi.byAgent("company-1");
    expect(lastRequest().url).toBe("/api/companies/company-1/costs/by-agent");
  });

  it("byAgentModel uses kebab-case path", async () => {
    await costsApi.byAgentModel("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/by-agent-model",
    );
  });

  it("byProject GET /api/companies/:id/costs/by-project", async () => {
    await costsApi.byProject("company-1");
    expect(lastRequest().url).toBe("/api/companies/company-1/costs/by-project");
  });

  it("byProvider GET /api/companies/:id/costs/by-provider", async () => {
    await costsApi.byProvider("company-1");
    expect(lastRequest().url).toBe("/api/companies/company-1/costs/by-provider");
  });

  it("byBiller GET /api/companies/:id/costs/by-biller", async () => {
    await costsApi.byBiller("company-1");
    expect(lastRequest().url).toBe("/api/companies/company-1/costs/by-biller");
  });

  it("financeSummary uses the kebab-case suffix", async () => {
    await costsApi.financeSummary("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/finance-summary",
    );
  });

  it("financeByBiller and financeByKind use kebab-case suffixes", async () => {
    await costsApi.financeByBiller("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/finance-by-biller",
    );
    await costsApi.financeByKind("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/finance-by-kind",
    );
  });

  it("financeEvents forwards limit param", async () => {
    await costsApi.financeEvents("company-1", undefined, undefined, 250);
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/finance-events?limit=250",
    );
  });

  it("windowSpend and quotaWindows hit the right paths", async () => {
    await costsApi.windowSpend("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/window-spend",
    );
    await costsApi.quotaWindows("company-1");
    expect(lastRequest().url).toBe(
      "/api/companies/company-1/costs/quota-windows",
    );
  });
});
