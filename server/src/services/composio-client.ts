/**
 * Composio client — thin fetch-based wrapper over Composio's REST v3 API.
 *
 * Strategic rationale (Wave 21):
 *   Composio (composio.dev) gives us 250+ SaaS tools through one managed
 *   OAuth flow. When `COMPOSIO_API_KEY` is set (and `COMPOSIO_V3_READY=1`)
 *   we route skill calls through Composio; otherwise every skill falls
 *   back to our hand-rolled clients (slack-client.ts, hubspot-client.ts,
 *   notion-client.ts, …).
 *
 * Design rules (enforced here):
 *   1. Composio is ADDITIVE. `isComposioEnabled()` is the only gate; if it
 *      returns false, nothing in this module is used in the hot path.
 *   2. All calls are scoped to `userId` — Composio's v3 `user_id` field —
 *      so credentials are per-user, never shared across a company.
 *   3. `COMPOSIO_API_KEY` is NEVER leaked through any API response. Public
 *      surface is limited to `isComposioEnabled` and `configuredApps`.
 *   4. On Composio failure we fail loud with `{ ok: false, reason }`; we do
 *      NOT silently dual-execute with the native client. That guarantees
 *      users who explicitly connected via Composio see a clean retry, not
 *      a surprise double-write.
 *
 * v3 endpoints used (via `@composio/client` exploration, confirmed paths):
 *   - POST /api/v3/tools/execute/{toolSlug}     — execute a tool as a user
 *   - POST /api/v3/connected_accounts           — initiate a new OAuth flow
 *   - GET  /api/v3/connected_accounts/{id}      — read connection status
 *   - GET  /api/v3/toolkits?limit=1             — used by health check only
 *
 * v3 architectural note — `auth_config`:
 *   v3 no longer auto-creates an auth config from an app slug. Each toolkit
 *   you want to let users connect to requires a pre-created `auth_config`
 *   (done once per instance in the Composio dashboard). We resolve the
 *   config id per-app from the env var `COMPOSIO_AUTH_CONFIG_<APPNAME>`
 *   (uppercased). If unset, `initiateConnection` fails loud with a
 *   setup-instructive error rather than hanging.
 *
 * Why fetch (not the official SDK):
 *   `@composio/core` pulls in `openai` + `pusher-js` transitively and ties
 *   us to its version cadence. A ~250-line fetch wrapper hitting a handful
 *   of v3 REST routes is stable, auditable, and trivially mockable in
 *   tests.
 */

import { logger } from "../middleware/logger.js";

/** Apps we ship first-class skills for today. Purely informational. */
export const COMPOSIO_CONFIGURED_APPS = [
  "slack",
  "hubspot",
  "notion",
  "linkedin",
] as const;

export type ComposioAppName = (typeof COMPOSIO_CONFIGURED_APPS)[number] | string;

/**
 * Base URL for the Composio v3 REST API. The default points at the public
 * backend with the v3 prefix. Override via `COMPOSIO_API_BASE_URL` for
 * staging or a proxy.
 */
export const COMPOSIO_API_BASE_URL =
  process.env.COMPOSIO_API_BASE_URL ?? "https://backend.composio.dev";

const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Public gate ─────────────────────────────────────────────────────────

export function isComposioEnabled(): boolean {
  const key = process.env.COMPOSIO_API_KEY;
  const hasKey = typeof key === "string" && key.trim().length > 0;
  if (!hasKey) return false;

  // The `COMPOSIO_V3_READY` flag originally gated the v1→v3 migration (see
  // ticket 001). Now that the client is v3-native, the flag remains as a
  // belt-and-suspenders rollout switch: set `COMPOSIO_V3_READY=1` on any
  // environment where a real integration has been verified end-to-end.
  // Unset/false = graceful degrade to "not enabled".
  const v3Ready = process.env.COMPOSIO_V3_READY === "1";
  return v3Ready;
}

// ─── Auth config resolution (v3 requirement) ─────────────────────────────

/**
 * v3 requires a pre-created `auth_config.id` for each toolkit. We read it
 * from `COMPOSIO_AUTH_CONFIG_<APP>` where `<APP>` is the uppercased app
 * slug (e.g. `slack` → `COMPOSIO_AUTH_CONFIG_SLACK`).
 *
 * Null means the operator has not yet set up a Composio auth config for
 * this toolkit — the caller should surface the setup error to the user,
 * not silently fail.
 */
export function resolveComposioAuthConfigId(
  appName: ComposioAppName,
): string | null {
  const envKey = `COMPOSIO_AUTH_CONFIG_${appName.toUpperCase()}`;
  const val = process.env[envKey];
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface ComposioExecuteInput {
  /** FounderOS user id — mapped 1:1 to Composio `user_id`. */
  userId: string;
  /** Composio tool slug, e.g. `slack_send_message` or `GITHUB_GET_REPOS`. */
  toolName: string;
  /** Arguments for the tool; Composio validates these server-side. */
  params: Record<string, unknown>;
  /**
   * Optional explicit connected-account id to route the execution through.
   * When omitted, Composio selects an active connected account for the
   * given `user_id` and the toolkit implied by the tool slug.
   */
  connectedAccountId?: string;
}

export type ComposioExecuteResult =
  | { ok: true; output: Record<string, unknown> }
  | {
      ok: false;
      reason: "composio_error" | "not_enabled";
      message: string;
    };

export interface ComposioInitiateConnectionInput {
  userId: string;
  appName: ComposioAppName;
  /**
   * Optional URL to return the user to after consent. Composio appends
   * identifiers to this URL on successful completion.
   */
  redirectUri?: string;
  /**
   * Optional explicit auth-config id. When omitted, resolved from the env
   * var `COMPOSIO_AUTH_CONFIG_<APP>`; initiating fails loud if neither is
   * available.
   */
  authConfigId?: string;
}

export interface ComposioInitiateConnectionResult {
  connectionId: string;
  redirectUrl: string;
}

export type ComposioConnectionStatus =
  | "pending"
  | "active"
  | "failed"
  | "revoked"
  | "unknown";

export interface ComposioConnection {
  connectionId: string;
  status: ComposioConnectionStatus;
  appName?: string;
  entityId?: string;
}

export interface ComposioClient {
  executeTool(input: ComposioExecuteInput): Promise<ComposioExecuteResult>;
  initiateConnection(
    input: ComposioInitiateConnectionInput,
  ): Promise<ComposioInitiateConnectionResult>;
  getConnection(params: {
    connectionId: string;
  }): Promise<ComposioConnection>;
}

// ─── Implementation ──────────────────────────────────────────────────────

interface ComposioFetchDeps {
  fetchImpl?: typeof fetch;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

async function composioFetch<T>(
  deps: ComposioFetchDeps,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { fetchImpl = fetch, apiKey, baseUrl, timeoutMs } = deps;
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetchImpl(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const msg =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `Composio ${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v3 connection status vocabulary is `INITIALIZING | INITIATED | ACTIVE |
 * FAILED | EXPIRED | INACTIVE`. We normalize to a stable four-value enum
 * for the rest of the app.
 */
function normalizeConnectionStatus(raw: unknown): ComposioConnectionStatus {
  if (typeof raw !== "string") return "unknown";
  const v = raw.toLowerCase();
  if (v === "active" || v === "connected") return "active";
  if (v === "initializing" || v === "initiated" || v === "pending") return "pending";
  if (v === "failed" || v === "error" || v === "expired") return "failed";
  if (v === "inactive" || v === "revoked" || v === "deleted") return "revoked";
  return "unknown";
}

/**
 * Response body for POST /api/v3/connected_accounts. The SDK describes a
 * large `connectionData` union; for our purposes we only need the ids and
 * the redirect URL, which lives either in the top-level (deprecated) or
 * inside `connectionData.val.redirectUrl` / `connectionData.val.authUri`.
 */
interface V3CreateConnectedAccountResponse {
  id?: string;
  status?: string;
  redirect_url?: string | null;
  redirect_uri?: string | null;
  connectionData?: {
    authScheme?: string;
    val?: {
      redirectUrl?: string;
      authUri?: string;
      [k: string]: unknown;
    };
  };
}

function extractRedirectUrl(raw: V3CreateConnectedAccountResponse): string {
  // Prefer the v3 union-shape `connectionData.val.redirectUrl`/`authUri`;
  // fall back to the deprecated top-level fields for older responses.
  const val = raw.connectionData?.val;
  const fromVal =
    typeof val?.redirectUrl === "string" && val.redirectUrl.length > 0
      ? val.redirectUrl
      : typeof val?.authUri === "string" && val.authUri.length > 0
        ? val.authUri
        : undefined;
  return (fromVal ?? raw.redirect_url ?? raw.redirect_uri ?? "") as string;
}

export interface CreateComposioClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createComposioClient(
  opts: CreateComposioClientOptions = {},
): ComposioClient {
  const apiKey = opts.apiKey ?? process.env.COMPOSIO_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "createComposioClient: COMPOSIO_API_KEY is not set; call isComposioEnabled() first.",
    );
  }
  const deps: ComposioFetchDeps = {
    apiKey,
    baseUrl: opts.baseUrl ?? COMPOSIO_API_BASE_URL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  };

  return {
    async executeTool(input) {
      try {
        // v3 execute body: `{ user_id, arguments, connected_account_id?, version?, text?, allow_tracing? }`.
        // We don't pass `version` — letting Composio use the project's
        // active toolkit version avoids a hard failure when we upgrade.
        const body = {
          user_id: input.userId,
          arguments: input.params,
          ...(input.connectedAccountId
            ? { connected_account_id: input.connectedAccountId }
            : {}),
        };
        const raw = await composioFetch<{
          data?: Record<string, unknown>;
          error?: string;
          successful?: boolean;
          logId?: string;
        }>(
          deps,
          `/api/v3/tools/execute/${encodeURIComponent(input.toolName)}`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        const success = raw.successful ?? !raw.error;
        if (!success) {
          return {
            ok: false,
            reason: "composio_error",
            message: raw.error ?? "Composio execution failed",
          };
        }
        const output: Record<string, unknown> = raw.data ?? {};
        return { ok: true, output };
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown Composio error";
        logger.error(
          { err, toolName: input.toolName, userId: input.userId },
          `composio: executeTool failed — ${message}`,
        );
        return { ok: false, reason: "composio_error", message };
      }
    },

    async initiateConnection(input) {
      const authConfigId =
        input.authConfigId ?? resolveComposioAuthConfigId(input.appName);
      if (!authConfigId) {
        throw new Error(
          `composio: no auth_config id configured for app "${input.appName}". ` +
            `Create one in the Composio dashboard and set COMPOSIO_AUTH_CONFIG_${input.appName.toUpperCase()}.`,
        );
      }
      const body = {
        auth_config: { id: authConfigId },
        connection: {
          user_id: input.userId,
          ...(input.redirectUri ? { callback_url: input.redirectUri } : {}),
        },
      };
      const raw = await composioFetch<V3CreateConnectedAccountResponse>(
        deps,
        "/api/v3/connected_accounts",
        { method: "POST", body: JSON.stringify(body) },
      );
      const connectionId = raw.id ?? "";
      const redirectUrl = extractRedirectUrl(raw);
      if (!connectionId || !redirectUrl) {
        throw new Error(
          "composio: initiateConnection response missing connectionId or redirectUrl",
        );
      }
      return { connectionId, redirectUrl };
    },

    async getConnection(params) {
      const raw = await composioFetch<{
        id?: string;
        status?: string;
        user_id?: string;
        auth_config?: { id?: string; toolkit?: { slug?: string } };
        toolkit?: { slug?: string };
      }>(
        deps,
        `/api/v3/connected_accounts/${encodeURIComponent(params.connectionId)}`,
        { method: "GET" },
      );
      return {
        connectionId: raw.id ?? params.connectionId,
        status: normalizeConnectionStatus(raw.status),
        appName: raw.auth_config?.toolkit?.slug ?? raw.toolkit?.slug,
        entityId: raw.user_id,
      };
    },
  };
}

// ─── Singleton accessor ──────────────────────────────────────────────────

let cachedClient: ComposioClient | null = null;
let cachedKey: string | null = null;

/**
 * Lazy singleton. Returns `null` when Composio is not configured. Recreates
 * the client if the API key env var changes at runtime (makes tests easy).
 */
export function getComposioClient(): ComposioClient | null {
  if (!isComposioEnabled()) {
    cachedClient = null;
    cachedKey = null;
    return null;
  }
  const currentKey = process.env.COMPOSIO_API_KEY ?? "";
  if (!cachedClient || cachedKey !== currentKey) {
    cachedClient = createComposioClient({ apiKey: currentKey });
    cachedKey = currentKey;
  }
  return cachedClient;
}

/** Test-only helper — drop the singleton so the next call re-reads env. */
export function _resetComposioClientForTests(): void {
  cachedClient = null;
  cachedKey = null;
}

// ─── Convenience — top-level wrappers that use the singleton ─────────────

export async function executeTool(
  input: ComposioExecuteInput,
): Promise<ComposioExecuteResult> {
  const client = getComposioClient();
  if (!client) {
    return {
      ok: false,
      reason: "not_enabled",
      message: "Composio is not enabled",
    };
  }
  return client.executeTool(input);
}

export async function initiateConnection(
  input: ComposioInitiateConnectionInput,
): Promise<ComposioInitiateConnectionResult> {
  const client = getComposioClient();
  if (!client) {
    throw new Error("Composio is not enabled");
  }
  return client.initiateConnection(input);
}

export async function getConnection(params: {
  connectionId: string;
}): Promise<ComposioConnection> {
  const client = getComposioClient();
  if (!client) {
    throw new Error("Composio is not enabled");
  }
  return client.getConnection(params);
}
