// @vitest-environment jsdom

/**
 * Contract test for `adaptersApi`.
 *
 * Adapters are the agent execution backends (claude_local, codex_local,
 * cursor, etc.). The AdapterManager page calls list / install / remove /
 * setDisabled / setOverridePaused / reload / reinstall on this api. A wrong
 * URL or method here breaks the buyer's ability to install a CLI adapter,
 * which is the gating step for getting any agent to run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  supabase: {},
}));

import { adaptersApi } from "./adapters";

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
      json: async () => ({ ok: true }),
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

describe("adaptersApi contract", () => {
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

  it("list GETs /api/adapters", async () => {
    await adaptersApi.list();
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters");
    expect(req.method).toBe("GET");
  });

  it("install POSTs /api/adapters/install with the params envelope", async () => {
    await adaptersApi.install({ packageName: "@founderos/adapter-claude-local" });
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/install");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({
      packageName: "@founderos/adapter-claude-local",
    });
  });

  it("install forwards version + isLocalPath when present", async () => {
    await adaptersApi.install({
      packageName: "/local/path",
      version: "0.0.1",
      isLocalPath: true,
    });
    expect(lastRequest().body).toEqual({
      packageName: "/local/path",
      version: "0.0.1",
      isLocalPath: true,
    });
  });

  it("remove DELETEs /api/adapters/:type", async () => {
    await adaptersApi.remove("claude_local");
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/claude_local");
    expect(req.method).toBe("DELETE");
  });

  it("setDisabled PATCHes /api/adapters/:type with {disabled}", async () => {
    await adaptersApi.setDisabled("claude_local", true);
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/claude_local");
    expect(req.method).toBe("PATCH");
    expect(req.body).toEqual({ disabled: true });
  });

  it("setOverridePaused PATCHes /api/adapters/:type/override with {paused}", async () => {
    await adaptersApi.setOverridePaused("claude_local", true);
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/claude_local/override");
    expect(req.method).toBe("PATCH");
    expect(req.body).toEqual({ paused: true });
  });

  it("reload POSTs /api/adapters/:type/reload with an empty body", async () => {
    await adaptersApi.reload("claude_local");
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/claude_local/reload");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({});
  });

  it("reinstall POSTs /api/adapters/:type/reinstall with an empty body", async () => {
    await adaptersApi.reinstall("claude_local");
    const req = lastRequest();
    expect(req.url).toBe("/api/adapters/claude_local/reinstall");
    expect(req.method).toBe("POST");
  });
});
