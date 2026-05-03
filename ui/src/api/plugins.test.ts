// @vitest-environment jsdom

/**
 * Contract test for `pluginsApi`.
 *
 * Plugins are runtime-installed npm packages that extend the FounderOS
 * server. The PluginManager page calls list / install / uninstall / enable
 * / disable on this api; a regressed path here breaks the entire plugin
 * lifecycle without a typecheck signal.
 *
 * Strategy: pin URL + method + body envelope per method. Bridge methods
 * (bridgeGetData, bridgePerformAction) are exercised separately by plugin
 * runtime tests; this file covers the management surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessTokenMock } = vi.hoisted(() => ({
  getAccessTokenMock: vi.fn().mockResolvedValue("test-bearer-token"),
}));

vi.mock("@/lib/supabase", () => ({
  getAccessToken: getAccessTokenMock,
  supabase: {},
}));

import { pluginsApi } from "./plugins";

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

describe("pluginsApi contract — management surface", () => {
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

  it("list GETs /api/plugins with no status param by default", async () => {
    await pluginsApi.list();
    const req = lastRequest();
    expect(req.url).toBe("/api/plugins");
    expect(req.method).toBe("GET");
  });

  it("list forwards a status filter as a query param", async () => {
    await pluginsApi.list("ready");
    expect(lastRequest().url).toBe("/api/plugins?status=ready");
  });

  it("listExamples GETs /api/plugins/examples", async () => {
    await pluginsApi.listExamples();
    expect(lastRequest().url).toBe("/api/plugins/examples");
  });

  it("get GETs /api/plugins/:id", async () => {
    await pluginsApi.get("plugin-uuid-1");
    expect(lastRequest().url).toBe("/api/plugins/plugin-uuid-1");
  });

  it("install POSTs /api/plugins/install with the install envelope", async () => {
    await pluginsApi.install({ packageName: "@founderos/plugin-linear" });
    const req = lastRequest();
    expect(req.url).toBe("/api/plugins/install");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ packageName: "@founderos/plugin-linear" });
  });

  it("uninstall DELETEs /api/plugins/:id without purge by default", async () => {
    await pluginsApi.uninstall("plugin-uuid-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/plugins/plugin-uuid-1");
    expect(req.method).toBe("DELETE");
  });

  it("uninstall(purge=true) appends the purge query param", async () => {
    await pluginsApi.uninstall("plugin-uuid-1", true);
    expect(lastRequest().url).toBe("/api/plugins/plugin-uuid-1?purge=true");
  });

  it("enable POSTs /api/plugins/:id/enable with an empty body", async () => {
    await pluginsApi.enable("plugin-uuid-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/plugins/plugin-uuid-1/enable");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({});
  });

  it("disable POSTs /api/plugins/:id/disable; reason omitted when undefined", async () => {
    await pluginsApi.disable("plugin-uuid-1");
    const req = lastRequest();
    expect(req.url).toBe("/api/plugins/plugin-uuid-1/disable");
    expect(req.body).toEqual({});
  });

  it("disable forwards reason when provided", async () => {
    await pluginsApi.disable("plugin-uuid-1", "operator pause");
    expect(lastRequest().body).toEqual({ reason: "operator pause" });
  });

  it("getConfig and saveConfig wrap the configJson envelope", async () => {
    await pluginsApi.getConfig("plugin-uuid-1");
    expect(lastRequest().url).toBe("/api/plugins/plugin-uuid-1/config");
    await pluginsApi.saveConfig("plugin-uuid-1", { foo: "bar" });
    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ configJson: { foo: "bar" } });
  });
});
