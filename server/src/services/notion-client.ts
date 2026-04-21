/**
 * Thin Notion API client — native fetch, no SDK dependency.
 *
 * Implements only the surface needed for the FounderOS sync:
 *   - getMe()              — health check / workspace identity
 *   - searchPages()        — paginated recent page objects (up to MAX_PAGES total)
 *
 * All requests carry a 10-second timeout enforced via AbortController.
 * Pagination follows Notion's cursor pattern: response.next_cursor.
 *
 * Docs: https://developers.notion.com/reference/
 */

export class NotionAuthError extends Error {
  constructor(message = "Notion authentication failed: invalid or expired access token") {
    super(message);
    this.name = "NotionAuthError";
  }
}

export interface NotionConfig {
  accessToken: string;
}

// ─── Notion response shapes ──────────────────────────────────────────────────

export interface NotionUser {
  object: "user";
  id: string;
  name?: string | null;
  type?: string;
  bot?: {
    workspace_name?: string | null;
    owner?: unknown;
  };
}

export interface NotionRichText {
  plain_text?: string;
  type?: string;
}

export interface NotionTitleProperty {
  id?: string;
  type: "title";
  title: NotionRichText[];
}

export type NotionProperty = NotionTitleProperty | { type: string; [k: string]: unknown };

export interface NotionPage {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  archived?: boolean;
  parent?: { type: string; [k: string]: unknown };
  properties: Record<string, NotionProperty>;
}

export interface NotionSearchResponse {
  object: "list";
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionClient {
  getMe(): Promise<NotionUser>;
  searchPages(): Promise<NotionPage[]>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGES = 100;
const PAGE_SIZE = 50;

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createNotionClient(config: NotionConfig): NotionClient {
  const authHeaders = {
    Authorization: `Bearer ${config.accessToken}`,
    "Notion-Version": NOTION_VERSION,
  };

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Notion request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(
        `Notion network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new NotionAuthError();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Notion API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async function getMe(): Promise<NotionUser> {
    return apiFetch<NotionUser>("/users/me");
  }

  async function searchPages(): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | undefined;

    while (pages.length < MAX_PAGES) {
      const remaining = MAX_PAGES - pages.length;
      const pageSize = Math.min(PAGE_SIZE, remaining);

      const body: Record<string, unknown> = {
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: pageSize,
      };
      if (cursor) {
        body.start_cursor = cursor;
      }

      const data = await apiFetch<NotionSearchResponse>("/search", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (data.results.length === 0) break;
      pages.push(...data.results);

      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    return pages;
  }

  return { getMe, searchPages };
}
