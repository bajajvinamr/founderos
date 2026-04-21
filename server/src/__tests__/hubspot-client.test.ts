import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHubspotClient, HubspotAuthError } from "../services/hubspot-client.js";

// ─── Mock global fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number): Response {
  return new Response(JSON.stringify({ message: "error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "pat-na1-test-token-abc123";
const BASE_URL = "https://api.hubapi.com";

const MOCK_PIPELINE = {
  id: "default",
  label: "Sales Pipeline",
  displayOrder: 0,
  stages: [
    {
      id: "appointmentscheduled",
      label: "Appointment Scheduled",
      displayOrder: 1,
      metadata: { probability: "0.2" },
    },
    {
      id: "qualifiedtobuy",
      label: "Qualified To Buy",
      displayOrder: 2,
      metadata: { probability: "0.4" },
    },
    {
      id: "closedwon",
      label: "Closed Won",
      displayOrder: 5,
      metadata: { probability: "1.0", isWon: "true", isClosed: "true" },
    },
  ],
};

const MOCK_DEAL = {
  id: "deal-1",
  properties: {
    dealname: "Acme Corp",
    amount: "10000.00",
    dealstage: "appointmentscheduled",
    closedate: "2026-06-01T00:00:00.000Z",
    pipeline: "default",
    hubspot_owner_id: "owner-42",
  },
};

function getClient() {
  return createHubspotClient({ accessToken: ACCESS_TOKEN });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createHubspotClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("getDealPipelines", () => {
    it("calls GET /crm/v3/pipelines/deals with correct auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [MOCK_PIPELINE] }),
      );

      const client = getClient();
      const pipelines = await client.getDealPipelines();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/crm/v3/pipelines/deals`);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0].id).toBe("default");
      expect(pipelines[0].stages).toHaveLength(3);
    });

    it("throws HubspotAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
      await expect(getClient().getDealPipelines()).rejects.toThrow(HubspotAuthError);
    });

    it("throws HubspotAuthError on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
      await expect(getClient().getDealPipelines()).rejects.toThrow(HubspotAuthError);
    });

    it("throws with meaningful message on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(getClient().getDealPipelines()).rejects.toThrow(
        /HubSpot network error.*ECONNREFUSED/,
      );
    });
  });

  describe("getDeals", () => {
    it("calls GET /crm/v3/objects/deals with correct URL and auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [MOCK_DEAL], paging: undefined }),
      );

      const client = getClient();
      const deals = await client.getDeals();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(`${BASE_URL}/crm/v3/objects/deals`);
      expect(url).toContain("dealname");
      expect(url).toContain("amount");
      expect(url).toContain("dealstage");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(deals).toHaveLength(1);
      expect(deals[0].id).toBe("deal-1");
    });

    it("parses deal properties correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [MOCK_DEAL] }),
      );

      const client = getClient();
      const deals = await client.getDeals();

      expect(deals[0].properties.dealname).toBe("Acme Corp");
      expect(deals[0].properties.amount).toBe("10000.00");
      expect(deals[0].properties.dealstage).toBe("appointmentscheduled");
      expect(deals[0].properties.pipeline).toBe("default");
      expect(deals[0].properties.hubspot_owner_id).toBe("owner-42");
    });

    it("follows pagination until exhausted", async () => {
      const page1Deal = { ...MOCK_DEAL, id: "deal-page1" };
      const page2Deal = { ...MOCK_DEAL, id: "deal-page2" };

      // Page 1 — has a next cursor
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          results: [page1Deal],
          paging: { next: { after: "cursor-abc" } },
        }),
      );
      // Page 2 — no next cursor, pagination ends
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          results: [page2Deal],
          paging: undefined,
        }),
      );

      const client = getClient();
      const deals = await client.getDeals();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(deals).toHaveLength(2);
      expect(deals[0].id).toBe("deal-page1");
      expect(deals[1].id).toBe("deal-page2");

      // Second call must include the after cursor
      const [url2] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url2).toContain("after=cursor-abc");
    });

    it("stops at MAX_DEALS (200) cap even if more pages exist", async () => {
      // Generate 100 deals for page 1 and 100 for page 2 (hitting cap)
      const makeDeals = (count: number, prefix: string) =>
        Array.from({ length: count }, (_, i) => ({
          ...MOCK_DEAL,
          id: `${prefix}-${i}`,
        }));

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          results: makeDeals(100, "p1"),
          paging: { next: { after: "cursor-1" } },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          results: makeDeals(100, "p2"),
          paging: { next: { after: "cursor-2" } }, // would continue but we cap
        }),
      );

      const client = getClient();
      const deals = await client.getDeals();

      // Should stop after 200 total — no third fetch
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(deals).toHaveLength(200);
    });

    it("filters by pipelineId when provided", async () => {
      const matchingDeal = { ...MOCK_DEAL, id: "match", properties: { ...MOCK_DEAL.properties, pipeline: "target-pipeline" } };
      const otherDeal = { ...MOCK_DEAL, id: "other", properties: { ...MOCK_DEAL.properties, pipeline: "other-pipeline" } };

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [matchingDeal, otherDeal] }),
      );

      const client = getClient();
      const deals = await client.getDeals("target-pipeline");

      expect(deals).toHaveLength(1);
      expect(deals[0].id).toBe("match");
    });

    it("throws HubspotAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
      await expect(getClient().getDeals()).rejects.toThrow(HubspotAuthError);
    });

    it("throws with meaningful message on non-auth API error", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(429));
      await expect(getClient().getDeals()).rejects.toThrow(/HubSpot API error 429/);
    });

    it("returns empty array when results is empty", async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ results: [] }));
      const deals = await getClient().getDeals();
      expect(deals).toEqual([]);
    });
  });
});
