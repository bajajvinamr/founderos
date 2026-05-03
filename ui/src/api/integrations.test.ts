// @vitest-environment jsdom

/**
 * Contract test for `integrationsApi`.
 *
 * Integrations creates the Slack/Gmail/Notion/etc. connections that drive
 * agent execution. A wrong path or method here means buyers can't connect
 * any tool — and there's no typecheck signal because the path is a string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  supabase: {},
}));

import { integrationsApi } from "./integrations";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function captureFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  lastRequest: () => CapturedRequest;
} {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as string
      }
    }
    calls.push({ url, method: init?.method ?? "GET", body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "int-1" }),
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

describe("integrationsApi contract", () => {
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

  it("list GETs /api/companies/:id/integrations", async () => {
    await integrationsApi.list("company-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/integrations");
    expect(req.method).toBe("GET");
  });

  it("create POSTs the {kind, apiKey, config} envelope", async () => {
    await integrationsApi.create("company-1", {
      kind: "slack",
      apiKey: "xoxb-fake",
      config: { teamId: "T1" },
    });
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/integrations");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({
      kind: "slack",
      apiKey: "xoxb-fake",
      config: { teamId: "T1" },
    });
  });

  it("remove DELETEs /api/companies/:id/integrations/:integrationId", async () => {
    await integrationsApi.remove("company-1", "int-42");
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/integrations/int-42");
    expect(req.method).toBe("DELETE");
  });

  it("test POSTs to /test sub-resource", async () => {
    await integrationsApi.test("company-1", "int-42");
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/integrations/int-42/test");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({});
  });

  it("listSlackChannels GETs the slack-scoped sub-resource", async () => {
    await integrationsApi.listSlackChannels("company-1");
    const req = lastRequest();
    expect(req.url).toBe(
      "/api/companies/company-1/integrations/slack/channels",
    );
    expect(req.method).toBe("GET");
  });
});
