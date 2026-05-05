/**
 * Thin PostHog API client — native fetch, no SDK dependency.
 *
 * Implements the surface needed for the Growth console integration (S2.3):
 *   - listProjects()          — list projects accessible with the API key
 *   - validateApiKey()        — verify an API key by hitting /api/projects/:id
 *   - getEventCounts()        — HogQL event aggregation
 *   - getUtmSourceBreakdown() — HogQL UTM attribution
 *   - listEvents()            — paginated event fetch for polling fallback
 *
 * HMAC signature verification is exported separately:
 *   - verifyPostHogWebhookSignature()
 *
 * All requests carry a 10-second timeout enforced via AbortController.
 *
 * Supported hosts (v1): https://us.posthog.com, https://eu.posthog.com
 * Self-hosted: intentionally excluded per ROADMAP cross-cutting decision.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export class PostHogAuthError extends Error {
  constructor(message = "PostHog authentication failed: invalid or expired API key") {
    super(message);
    this.name = "PostHogAuthError";
  }
}

export interface PostHogConfig {
  apiKey: string;
  /** Defaults to https://us.posthog.com */
  host?: string;
  /** If unset, syncPostHog resolves the first available project. */
  projectId?: string;
}

export interface PostHogProject {
  id: number;
  name: string;
}

interface PostHogHogQLResponse {
  results: Array<Array<string | number>>;
  columns: string[];
}

/** Shape of a raw PostHog event from /api/projects/:id/events */
export interface PostHogRawEvent {
  id: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

interface PostHogEventsPage {
  results: PostHogRawEvent[];
  next: string | null;
}

export interface ListEventsOptions {
  /** ISO-8601 timestamp — fetch events with timestamp > after */
  after?: string;
  /** Default 100, max 1000 per PostHog docs. */
  limit?: number;
}

export interface PostHogClient {
  listProjects(): Promise<PostHogProject[]>;
  validateApiKey(projectId: string | number): Promise<PostHogProject>;
  getEventCounts(
    projectId: number,
    events: string[],
    since: Date,
  ): Promise<Record<string, number>>;
  getUtmSourceBreakdown(
    projectId: number,
    since: Date,
  ): Promise<Array<{ source: string; count: number }>>;
  listEvents(
    projectId: number,
    opts?: ListEventsOptions,
  ): Promise<{ events: PostHogRawEvent[]; nextPage: string | null }>;
}

/**
 * Verify a PostHog webhook HMAC-SHA256 signature.
 *
 * PostHog signs webhook payloads with HMAC-SHA256 using the project's webhook
 * secret. The digest is sent as the PostHog-Signature header:
 *   sha256=<hex-digest>
 */
export function verifyPostHogWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;

  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(prefix + digest, "utf8");
  const received = Buffer.from(signature, "utf8");

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createPostHogClient(config: PostHogConfig): PostHogClient {
  const baseUrl = (config.host ?? "https://us.posthog.com").replace(/\/$/, "");
  const authHeaders = { Authorization: `Bearer ${config.apiKey}` };

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
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
        throw new Error(`PostHog request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(
        `PostHog network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new PostHogAuthError();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PostHog API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async function listProjects(): Promise<PostHogProject[]> {
    const data = await apiFetch<{ results: PostHogProject[] }>("/api/projects/");
    return data.results;
  }

  async function validateApiKey(
    projectId: string | number,
  ): Promise<PostHogProject> {
    return apiFetch<PostHogProject>(`/api/projects/${projectId}`);
  }

  async function runHogQL(
    projectId: number,
    query: string,
  ): Promise<PostHogHogQLResponse> {
    return apiFetch<PostHogHogQLResponse>(
      `/api/projects/${projectId}/query/`,
      {
        method: "POST",
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      },
    );
  }

  async function getEventCounts(
    projectId: number,
    events: string[],
    since: Date,
  ): Promise<Record<string, number>> {
    if (events.length === 0) return {};

    const inList = events.map((e) => `'${e.replace(/'/g, "\\'")}'`).join(", ");
    const sinceIso = since.toISOString();

    const hql = `
      SELECT event, count() AS cnt
      FROM events
      WHERE event IN (${inList})
        AND timestamp >= '${sinceIso}'
      GROUP BY event
    `.trim();

    const result = await runHogQL(projectId, hql);

    const counts: Record<string, number> = {};
    for (const e of events) counts[e] = 0;

    for (const row of result.results) {
      const [eventName, count] = row;
      if (typeof eventName === "string" && typeof count === "number") {
        counts[eventName] = count;
      }
    }

    return counts;
  }

  async function getUtmSourceBreakdown(
    projectId: number,
    since: Date,
  ): Promise<Array<{ source: string; count: number }>> {
    const sinceIso = since.toISOString();

    const hql = `
      SELECT properties.$initial_utm_source AS source, count() AS cnt
      FROM persons
      WHERE created_at >= '${sinceIso}'
      GROUP BY source
      ORDER BY cnt DESC
      LIMIT 10
    `.trim();

    const result = await runHogQL(projectId, hql);

    return result.results
      .map((row) => {
        const [source, count] = row;
        return {
          source: source == null || source === "" ? "(direct)" : String(source),
          count: typeof count === "number" ? count : 0,
        };
      })
      .filter((r) => r.count > 0);
  }

  async function listEvents(
    projectId: number,
    opts: ListEventsOptions = {},
  ): Promise<{ events: PostHogRawEvent[]; nextPage: string | null }> {
    const limit = opts.limit ?? 100;
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts.after) params.set("after", opts.after);

    const data = await apiFetch<PostHogEventsPage>(
      `/api/projects/${projectId}/events/?${params.toString()}`,
    );

    return { events: data.results, nextPage: data.next };
  }

  return {
    listProjects,
    validateApiKey,
    getEventCounts,
    getUtmSourceBreakdown,
    listEvents,
  };
}
