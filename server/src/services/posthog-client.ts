/**
 * Thin PostHog API client — native fetch, no SDK dependency.
 *
 * Implements only the surface needed for the Growth console integration:
 *   - listProjects()
 *   - getEventCounts()
 *   - getUtmSourceBreakdown()
 *
 * All requests carry a 10-second timeout enforced via AbortController.
 */

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

interface PostHogProject {
  id: number;
  name: string;
}

interface PostHogHogQLResponse {
  results: Array<Array<string | number>>;
  columns: string[];
}

export interface PostHogClient {
  listProjects(): Promise<PostHogProject[]>;
  getEventCounts(
    projectId: number,
    events: string[],
    since: Date,
  ): Promise<Record<string, number>>;
  getUtmSourceBreakdown(
    projectId: number,
    since: Date,
  ): Promise<Array<{ source: string; count: number }>>;
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
    // The /api/projects/ endpoint returns paginated results under .results
    const data = await apiFetch<{ results: PostHogProject[] }>("/api/projects/");
    return data.results;
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

    // Build a quoted list for the IN clause
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

    // Initialise every requested event to 0 so callers always get a complete map
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

  return { listProjects, getEventCounts, getUtmSourceBreakdown };
}
