import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPostHogClient, PostHogAuthError } from "../services/posthog-client.js";

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
  return new Response(JSON.stringify({ detail: "error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_KEY = "phc_test_key_abc123";
const BASE_URL = "https://us.posthog.com";

function getClient() {
  return createPostHogClient({ apiKey: API_KEY });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createPostHogClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("listProjects", () => {
    it("calls GET /api/projects/ with correct auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [{ id: 42, name: "My Project" }] }),
      );

      const client = getClient();
      const projects = await client.listProjects();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/projects/`);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${API_KEY}`,
      );
      expect(projects).toEqual([{ id: 42, name: "My Project" }]);
    });

    it("throws PostHogAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));

      const client = getClient();
      await expect(client.listProjects()).rejects.toThrow(PostHogAuthError);
    });

    it("throws PostHogAuthError on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(403));

      const client = getClient();
      await expect(client.listProjects()).rejects.toThrow(PostHogAuthError);
    });

    it("throws with meaningful message on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const client = getClient();
      await expect(client.listProjects()).rejects.toThrow(/PostHog network error.*ECONNREFUSED/);
    });
  });

  describe("getEventCounts", () => {
    it("POSTs to /api/projects/:id/query/ with parameterized HogQL (no interpolation)", async () => {
      const hogqlResponse = {
        columns: ["event", "cnt"],
        results: [
          ["$pageview", 1234],
          ["signed_up", 56],
        ],
      };
      mockFetch.mockResolvedValueOnce(makeJsonResponse(hogqlResponse));

      const client = getClient();
      const since = new Date("2024-01-01T00:00:00Z");
      const counts = await client.getEventCounts(42, ["$pageview", "signed_up"], since);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/projects/42/query/`);
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string) as {
        query: { kind: string; query: string; values: Record<string, string> };
      };
      expect(body.query.kind).toBe("HogQLQuery");

      // Event names must NOT be interpolated into the query string — they live in values.
      expect(body.query.query).not.toContain("$pageview");
      expect(body.query.query).not.toContain("signed_up");
      expect(body.query.query).toContain("2024-01-01");

      // Param refs {event0}, {event1} appear in the query; actual values are in values map.
      expect(body.query.query).toContain("{event0}");
      expect(body.query.query).toContain("{event1}");
      expect(body.query.values["event0"]).toBe("$pageview");
      expect(body.query.values["event1"]).toBe("signed_up");

      expect(counts["$pageview"]).toBe(1234);
      expect(counts["signed_up"]).toBe(56);
    });

    it("does not interpolate injection payloads into query string (CodeQL #11)", async () => {
      // Attacker-controlled event names: single-quote, backslash, semicolon, comment
      const maliciousEvents = [
        "legit",
        "'); DROP TABLE events; --",
        "\\' OR 1=1 --",
        "foo’bar",  // unicode right single quotation mark
      ];

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ columns: ["event", "cnt"], results: [] }),
      );

      const client = getClient();
      await client.getEventCounts(42, maliciousEvents, new Date("2024-01-01T00:00:00Z"));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        query: { kind: string; query: string; values: Record<string, string> };
      };

      // Query string must only have param refs, never raw event names.
      for (const ev of maliciousEvents) {
        expect(body.query.query).not.toContain(ev);
      }
      expect(body.query.query).not.toContain("DROP TABLE");
      expect(body.query.query).not.toContain("OR 1=1");

      // Actual values are in the values map — PostHog handles escaping.
      expect(body.query.values["event0"]).toBe("legit");
      expect(body.query.values["event1"]).toBe("'); DROP TABLE events; --");
      expect(body.query.values["event2"]).toBe("\\' OR 1=1 --");
      expect(body.query.values["event3"]).toBe("foo’bar");
    });

    it("returns 0 for events not present in results", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ columns: ["event", "cnt"], results: [] }),
      );

      const client = getClient();
      const counts = await client.getEventCounts(
        42,
        ["$pageview", "signed_up"],
        new Date(),
      );

      expect(counts["$pageview"]).toBe(0);
      expect(counts["signed_up"]).toBe(0);
    });

    it("throws PostHogAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));

      const client = getClient();
      await expect(
        client.getEventCounts(42, ["$pageview"], new Date()),
      ).rejects.toThrow(PostHogAuthError);
    });

    it("returns empty object when events list is empty", async () => {
      const client = getClient();
      const counts = await client.getEventCounts(42, [], new Date());
      expect(counts).toEqual({});
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getUtmSourceBreakdown", () => {
    it("POSTs HogQL for utm_source breakdown", async () => {
      const hogqlResponse = {
        columns: ["source", "cnt"],
        results: [
          ["google", 200],
          ["linkedin.com", 80],
          [null, 50],
        ],
      };
      mockFetch.mockResolvedValueOnce(makeJsonResponse(hogqlResponse));

      const client = getClient();
      const since = new Date("2024-01-01T00:00:00Z");
      const breakdown = await client.getUtmSourceBreakdown(42, since);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/projects/42/query/`);
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string) as {
        query: { kind: string; query: string };
      };
      expect(body.query.query).toContain("utm_source");

      expect(breakdown).toEqual([
        { source: "google", count: 200 },
        { source: "linkedin.com", count: 80 },
        { source: "(direct)", count: 50 },
      ]);
    });

    it("filters out entries with count 0", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          columns: ["source", "cnt"],
          results: [
            ["google", 100],
            ["bing", 0],
          ],
        }),
      );

      const client = getClient();
      const breakdown = await client.getUtmSourceBreakdown(42, new Date());
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].source).toBe("google");
    });
  });

  describe("custom host", () => {
    it("uses the provided host URL", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ results: [{ id: 1, name: "Proj" }] }),
      );

      const client = createPostHogClient({
        apiKey: API_KEY,
        host: "https://eu.posthog.com",
      });
      await client.listProjects();

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url.startsWith("https://eu.posthog.com")).toBe(true);
    });
  });
});
