// @vitest-environment jsdom

/**
 * Contract test for approvalsApi.
 *
 * Approve / reject / request-revision are the founder's primary review-flow
 * actions. A regression in any of these endpoints — wrong path, wrong method,
 * stripped body field — is invisible at typecheck time and only catches the
 * founder mid-review with a 404. The E2E suite exercises the API at the HTTP
 * boundary; this test exercises the *client* at the boundary, so a misnamed
 * route in `approvalsApi` is caught at unit time.
 *
 * Strategy: mock `fetch` and `getAccessToken`, fire each method, snapshot the
 * exact request that would have hit the server (URL, method, body, headers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the auth helper before importing the api client. Hoisted so the mock
// is in place before `client.ts` reads `getAccessToken` at module load.
const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  // The real module also exports `supabase`, but the api client only imports
  // getAccessToken. Re-export a placeholder so any indirect imports resolve.
  supabase: {},
}));

import { approvalsApi } from "./approvals";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function captureFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  lastRequest: () => CapturedRequest;
} {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const incoming = init?.headers;
    if (incoming instanceof Headers) {
      incoming.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (incoming) {
      for (const [key, value] of Object.entries(incoming)) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as string
      }
    }
    calls.push({ url, method: init?.method ?? "GET", body, headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "approval-id", status: "approved" }),
    } as Response;
  });
  return {
    fetchMock,
    lastRequest: () => {
      if (calls.length === 0) {
        throw new Error("fetch was never called");
      }
      return calls[calls.length - 1]!;
    },
  };
}

describe("approvalsApi contract", () => {
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
    getAccessTokenMock.mockResolvedValue("test-bearer-token");
  });

  afterEach(() => {
    restoreFetch();
    vi.clearAllMocks();
  });

  describe("approve(id)", () => {
    it("POSTs /api/approvals/:id/approve with an empty decisionNote payload", async () => {
      await approvalsApi.approve("appr-123");
      const req = lastRequest();
      expect(req.url).toBe("/api/approvals/appr-123/approve");
      expect(req.method).toBe("POST");
      expect(req.body).toEqual({ decisionNote: undefined });
      expect(req.headers["content-type"]).toBe("application/json");
    });

    it("attaches the bearer token from supabase auth", async () => {
      await approvalsApi.approve("appr-123");
      expect(lastRequest().headers["authorization"]).toBe("Bearer test-bearer-token");
    });

    it("forwards a decisionNote when provided", async () => {
      await approvalsApi.approve("appr-123", "looks good");
      expect(lastRequest().body).toEqual({ decisionNote: "looks good" });
    });

    it("does not attach Authorization header when no session is active", async () => {
      getAccessTokenMock.mockResolvedValueOnce(null);
      await approvalsApi.approve("appr-123");
      expect(lastRequest().headers["authorization"]).toBeUndefined();
    });
  });

  describe("reject(id)", () => {
    it("POSTs /api/approvals/:id/reject — distinct path from approve", async () => {
      await approvalsApi.reject("appr-456");
      const req = lastRequest();
      expect(req.url).toBe("/api/approvals/appr-456/reject");
      expect(req.method).toBe("POST");
      expect(req.url).not.toContain("/approve");
    });

    it("forwards a decisionNote when provided", async () => {
      await approvalsApi.reject("appr-456", "not enough evidence");
      expect(lastRequest().body).toEqual({ decisionNote: "not enough evidence" });
    });
  });

  describe("requestRevision(id)", () => {
    it("POSTs /api/approvals/:id/request-revision (kebab-case path)", async () => {
      await approvalsApi.requestRevision("appr-789", "tighten the scope");
      const req = lastRequest();
      expect(req.url).toBe("/api/approvals/appr-789/request-revision");
      expect(req.method).toBe("POST");
      expect(req.body).toEqual({ decisionNote: "tighten the scope" });
    });
  });

  describe("get(id) and listComments(id)", () => {
    it("GETs /api/approvals/:id with no body", async () => {
      await approvalsApi.get("appr-001");
      const req = lastRequest();
      expect(req.url).toBe("/api/approvals/appr-001");
      expect(req.method).toBe("GET");
      expect(req.body).toBeUndefined();
    });

    it("GETs /api/approvals/:id/comments for the comments list", async () => {
      await approvalsApi.listComments("appr-001");
      expect(lastRequest().url).toBe("/api/approvals/appr-001/comments");
    });
  });

  describe("propagates HTTP errors", () => {
    it("throws ApiError with the parsed error body when the server returns 409", async () => {
      const failingFetch = vi.fn(async () => {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Approval is not in a pending state" }),
        } as Response;
      });
      const original = globalThis.fetch;
      globalThis.fetch = failingFetch as unknown as typeof globalThis.fetch;
      try {
        await expect(approvalsApi.approve("appr-stale")).rejects.toMatchObject({
          name: "ApiError",
          status: 409,
          message: "Approval is not in a pending state",
        });
      } finally {
        globalThis.fetch = original;
      }
    });
  });
});
