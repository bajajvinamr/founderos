import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNotionClient,
  NotionAuthError,
  type NotionPage,
} from "../services/notion-client.js";
import {
  buildPageCard,
  extractPageTitle,
  syncNotion,
} from "../services/notion-sync.js";

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

const ACCESS_TOKEN = "secret_test_token_abc123";
const BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const MOCK_USER = {
  object: "user",
  id: "user-1",
  name: "Test Bot",
  type: "bot",
  bot: { workspace_name: "Test Workspace" },
};

function makePage(overrides: Partial<NotionPage> = {}): NotionPage {
  return {
    object: "page",
    id: overrides.id ?? "page-1",
    created_time: overrides.created_time ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: overrides.last_edited_time ?? "2026-04-20T12:00:00.000Z",
    url: overrides.url ?? "https://www.notion.so/Test-Page-abc",
    archived: overrides.archived ?? false,
    properties: overrides.properties ?? {
      Name: {
        type: "title",
        title: [{ plain_text: "Hello World", type: "text" }],
      },
    },
  };
}

// ─── Client tests ─────────────────────────────────────────────────────────────

describe("createNotionClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("getMe", () => {
    it("calls GET /users/me with correct auth + version headers", async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse(MOCK_USER));

      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      const me = await client.getMe();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/users/me`);
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(headers["Notion-Version"]).toBe(NOTION_VERSION);
      expect(me.id).toBe("user-1");
    });

    it("throws NotionAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      await expect(client.getMe()).rejects.toThrow(NotionAuthError);
    });

    it("throws NotionAuthError on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      await expect(client.getMe()).rejects.toThrow(NotionAuthError);
    });

    it("wraps network errors with a meaningful message", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      await expect(client.getMe()).rejects.toThrow(/Notion network error.*ECONNREFUSED/);
    });
  });

  describe("searchPages", () => {
    it("POSTs /search with the page filter and descending last_edited_time sort", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          object: "list",
          results: [makePage()],
          next_cursor: null,
          has_more: false,
        }),
      );

      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      const pages = await client.searchPages();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/search`);
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.filter).toEqual({ property: "object", value: "page" });
      expect(body.sort).toEqual({
        direction: "descending",
        timestamp: "last_edited_time",
      });
      expect(pages).toHaveLength(1);
      expect(pages[0].id).toBe("page-1");
    });

    it("follows pagination via next_cursor until has_more=false", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          object: "list",
          results: [makePage({ id: "p-1" })],
          next_cursor: "cursor-abc",
          has_more: true,
        }),
      );
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          object: "list",
          results: [makePage({ id: "p-2" })],
          next_cursor: null,
          has_more: false,
        }),
      );

      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      const pages = await client.searchPages();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(pages.map((p) => p.id)).toEqual(["p-1", "p-2"]);

      const secondBody = JSON.parse(
        (mockFetch.mock.calls[1]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(secondBody.start_cursor).toBe("cursor-abc");
    });

    it("throws NotionAuthError on 401", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      await expect(client.searchPages()).rejects.toThrow(NotionAuthError);
    });

    it("returns an empty array when results is empty", async () => {
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          object: "list",
          results: [],
          next_cursor: null,
          has_more: false,
        }),
      );
      const client = createNotionClient({ accessToken: ACCESS_TOKEN });
      await expect(client.searchPages()).resolves.toEqual([]);
    });
  });
});

// ─── Page shaping tests ───────────────────────────────────────────────────────

describe("extractPageTitle", () => {
  it("reads plain_text from the first title property", () => {
    const page = makePage({
      properties: {
        Name: {
          type: "title",
          title: [
            { plain_text: "Hello ", type: "text" },
            { plain_text: "World", type: "text" },
          ],
        },
      },
    });
    expect(extractPageTitle(page)).toBe("Hello World");
  });

  it("returns (untitled) when no title property exists", () => {
    const page = makePage({
      properties: {
        Status: { type: "select", select: { name: "Done" } },
      } as unknown as NotionPage["properties"],
    });
    expect(extractPageTitle(page)).toBe("(untitled)");
  });

  it("returns (untitled) when the title rich_text is empty", () => {
    const page = makePage({
      properties: {
        Name: { type: "title", title: [] },
      },
    });
    expect(extractPageTitle(page)).toBe("(untitled)");
  });
});

describe("buildPageCard", () => {
  it("maps a raw page into a card with title, snippet, url, timestamps", () => {
    const page = makePage({
      id: "pg-xyz",
      url: "https://www.notion.so/Pg-xyz",
      created_time: "2026-02-01T00:00:00.000Z",
      last_edited_time: "2026-04-19T10:00:00.000Z",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Roadmap Q2", type: "text" }] },
      },
    });

    expect(buildPageCard(page)).toEqual({
      id: "pg-xyz",
      title: "Roadmap Q2",
      url: "https://www.notion.so/Pg-xyz",
      lastEditedAt: "2026-04-19T10:00:00.000Z",
      createdAt: "2026-02-01T00:00:00.000Z",
      snippet: "Roadmap Q2",
      archived: false,
    });
  });

  it("truncates long titles into a snippet ending with an ellipsis", () => {
    const longTitle = "A".repeat(500);
    const page = makePage({
      properties: {
        Name: { type: "title", title: [{ plain_text: longTitle, type: "text" }] },
      },
    });
    const card = buildPageCard(page);
    expect(card.title).toBe(longTitle); // title preserved
    expect(card.snippet.length).toBeLessThanOrEqual(200);
    expect(card.snippet.endsWith("…")).toBe(true);
  });

  it("marks archived pages as archived=true", () => {
    const page = makePage({ archived: true });
    expect(buildPageCard(page).archived).toBe(true);
  });
});

// ─── Sync service tests (with a mocked Db) ────────────────────────────────────

/**
 * Lightweight chainable mock of the subset of the Drizzle API used by
 * syncNotion: db.insert(...).values(...).onConflictDoUpdate(...) and
 * db.update(...).set(...).where(...).
 *
 * Each chain method returns `this` and the terminal awaitable resolves to
 * undefined. Calls are recorded so we can assert writes happened.
 */
function makeMockDb() {
  const calls: { op: string; args: unknown[] }[] = [];

  const insertChain = {
    values(v: unknown) {
      calls.push({ op: "insert.values", args: [v] });
      return this;
    },
    onConflictDoUpdate(c: unknown) {
      calls.push({ op: "insert.onConflictDoUpdate", args: [c] });
      return Promise.resolve(undefined);
    },
  };

  const updateChain = {
    set(v: unknown) {
      calls.push({ op: "update.set", args: [v] });
      return this;
    },
    where(w: unknown) {
      calls.push({ op: "update.where", args: [w] });
      return Promise.resolve(undefined);
    },
  };

  const db = {
    insert() {
      calls.push({ op: "insert", args: [] });
      return insertChain;
    },
    update() {
      calls.push({ op: "update", args: [] });
      return updateChain;
    },
  };

  // Cast is necessary because we only implement a narrow subset of Db.
  return { db: db as unknown as import("@founderos/db").Db, calls };
}

describe("syncNotion", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("writes notion.pages payload on success and marks integration connected", async () => {
    // getMe
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MOCK_USER));
    // searchPages (single page, no more)
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        object: "list",
        results: [
          makePage({ id: "p-a" }),
          makePage({
            id: "p-b",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Second Page", type: "text" }],
              },
            },
          }),
        ],
        next_cursor: null,
        has_more: false,
      }),
    );

    const { db, calls } = makeMockDb();

    const result = await syncNotion({
      db,
      integrationId: "int-1",
      companyId: "co-1",
      decryptedApiKey: ACCESS_TOKEN,
    });

    expect(result).toEqual({ ok: true, synced: ["notion.pages"] });

    const insertValues = calls.find((c) => c.op === "insert.values");
    expect(insertValues).toBeDefined();
    const payload = (insertValues!.args[0] as {
      payload: { totalPages: number; pages: Array<{ id: string; title: string }> };
    }).payload;
    expect(payload.totalPages).toBe(2);
    expect(payload.pages.map((p) => p.id)).toEqual(["p-a", "p-b"]);
    expect(payload.pages[1].title).toBe("Second Page");

    // Status update to connected
    const setCall = calls.find(
      (c) => c.op === "update.set" && (c.args[0] as { status?: string }).status === "connected",
    );
    expect(setCall).toBeDefined();
  });

  it("filters archived pages out of the payload", async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MOCK_USER));
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({
        object: "list",
        results: [
          makePage({ id: "live-1" }),
          makePage({ id: "archived-1", archived: true }),
        ],
        next_cursor: null,
        has_more: false,
      }),
    );

    const { db, calls } = makeMockDb();
    const result = await syncNotion({
      db,
      integrationId: "int-1",
      companyId: "co-1",
      decryptedApiKey: ACCESS_TOKEN,
    });
    expect(result.ok).toBe(true);

    const insertValues = calls.find((c) => c.op === "insert.values")!;
    const payload = (insertValues.args[0] as {
      payload: { totalPages: number; pages: Array<{ id: string }> };
    }).payload;
    expect(payload.totalPages).toBe(1);
    expect(payload.pages.map((p) => p.id)).toEqual(["live-1"]);
  });

  it("returns ok:false and flips status to error on auth failure", async () => {
    // getMe returns 401 → NotionAuthError
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));

    const { db, calls } = makeMockDb();
    const result = await syncNotion({
      db,
      integrationId: "int-1",
      companyId: "co-1",
      decryptedApiKey: "bad-token",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Notion authentication failed/);
    }

    // Should NOT have written integration_data (insert never called) but
    // should have updated integrations.status to "error".
    expect(calls.some((c) => c.op === "insert")).toBe(false);
    const errorSet = calls.find(
      (c) => c.op === "update.set" && (c.args[0] as { status?: string }).status === "error",
    );
    expect(errorSet).toBeDefined();
    expect((errorSet!.args[0] as { lastError?: string }).lastError).toMatch(
      /Notion authentication failed/,
    );
  });

  it("returns ok:false when Notion API returns a non-auth error", async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse(MOCK_USER));
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));

    const { db } = makeMockDb();
    const result = await syncNotion({
      db,
      integrationId: "int-1",
      companyId: "co-1",
      decryptedApiKey: ACCESS_TOKEN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Notion API error 500/);
    }
  });
});
