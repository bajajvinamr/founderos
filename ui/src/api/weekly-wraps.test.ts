// @vitest-environment jsdom

/**
 * Contract test for `weeklyWrapsApi`.
 *
 * Weekly wraps power the Friday 5pm digest — both the in-app `/weekly` page
 * and the auto-delivered email/Slack copy. A wrong path silently breaks the
 * digest cron and the buyer's "what shipped this week" briefing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  supabase: {},
}));

import { weeklyWrapsApi } from "./weekly-wraps";

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

describe("weeklyWrapsApi contract", () => {
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

  it("list GETs /api/companies/:id/weekly-wraps (kebab-case)", async () => {
    await weeklyWrapsApi.list("company-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/companies/company-1/weekly-wraps");
    expect(req.method).toBe("GET");
  });

  it("detail GETs /api/companies/:id/weekly-wraps/:wrapId", async () => {
    await weeklyWrapsApi.detail("company-1", "wrap-2026-04-26");
    const req = lastRequest();
    expect(req.url).toBe(
      "/api/companies/company-1/weekly-wraps/wrap-2026-04-26",
    );
    expect(req.method).toBe("GET");
  });

  it("generateNow POSTs to /generate-now with an empty body", async () => {
    await weeklyWrapsApi.generateNow("company-1");
    const req = lastRequest();
    expect(req.url).toBe(
      "/api/companies/company-1/weekly-wraps/generate-now",
    );
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({});
  });
});
