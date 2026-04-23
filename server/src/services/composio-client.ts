/**
 * Composio client — thin fetch-based wrapper over Composio's REST API.
 *
 * Strategic rationale (Wave 21):
 *   Composio (composio.dev) gives us 250+ SaaS tools through one SDK + one
 *   managed OAuth flow. When `COMPOSIO_API_KEY` is set we route skill calls
 *   through Composio; otherwise every skill falls back to our hand-rolled
 *   clients (slack-client.ts, hubspot-client.ts, notion-client.ts, …).
 *
 * Design rules (enforced here):
 *   1. Composio is ADDITIVE. `isComposioEnabled()` is the only gate; if it
 *      returns false, nothing in this module is used in the hot path.
 *   2. All calls are scoped to `userId` (the FounderOS user id) which maps
 *      1:1 to a Composio "entity" — so credentials are per-user, never
 *      shared across a company.
 *   3. `COMPOSIO_API_KEY` is NEVER leaked through any API response. Public
 *      surface is limited to `isComposioEnabled` and `configuredApps`.
 *   4. On Composio failure we fail loud with `{ ok: false, reason }`; we do
 *      NOT silently dual-execute with the native client. That guarantees
 *      users who explicitly connected via Composio see a clean retry, not
 *      a surprise double-write.
 *
 * Why fetch (not the official SDK):
 *   The `composio-core` / `@composio/core` npm packages have had several
 *   breaking API revisions. A ~150-line fetch wrapper hitting
 *   `https://backend.composio.dev/api/v1/` with `x-api-key` is stable,
 *   auditable, and trivially mockable in tests.
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

export const COMPOSIO_API_BASE_URL =
  process.env.COMPOSIO_API_BASE_URL ?? "https://backend.composio.dev/api/v1";

const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Public gate ─────────────────────────────────────────────────────────

export function isComposioEnabled(): boolean {
  const key = process.env.COMPOSIO_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface ComposioExecuteInput {
  /** FounderOS user id — mapped to a Composio entity. */
  userId: string;
  /** Composio action / tool slug, e.g. `slack_send_message`. */
  toolName: string;
  /** Parameters for the tool; Composio validates these server-side. */
  params: Record<string, unknown>;
}

export type ComposioExecuteResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; reason: "composio_error" | "not_enabled"; message: string };

export interface ComposioInitiateConnectionInput {
  userId: string;
  appName: ComposioAppName;
  /**
   * Optional URL to return the user to after consent. Composio appends
   * `?connectedAccountId=…` when set.
   */
  redirectUri?: string;
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

function normalizeConnectionStatus(raw: unknown): ComposioConnectionStatus {
  if (typeof raw !== "string") return "unknown";
  const v = raw.toLowerCase();
  if (v === "active" || v === "connected") return "active";
  if (v === "pending" || v === "initiated") return "pending";
  if (v === "failed" || v === "error") return "failed";
  if (v === "revoked" || v === "deleted") return "revoked";
  return "unknown";
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
        const body = {
          appName: undefined as string | undefined,
          actionName: input.toolName,
          entityId: input.userId,
          input: input.params,
        };
        // Composio's "execute action" endpoint accepts the action slug and
        // the entity (user) id under which to run. The slug itself encodes
        // the app, so we do not send `appName` here.
        const raw = await composioFetch<{
          successfull?: boolean;
          successful?: boolean;
          data?: Record<string, unknown>;
          response_data?: Record<string, unknown>;
          error?: string;
        }>(deps, `/actions/${encodeURIComponent(input.toolName)}/execute`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const success = raw.successful ?? raw.successfull ?? true;
        if (!success) {
          return {
            ok: false,
            reason: "composio_error",
            message: raw.error ?? "Composio execution failed",
          };
        }
        const output =
          (raw.data as Record<string, unknown> | undefined) ??
          (raw.response_data as Record<string, unknown> | undefined) ??
          {};
        return { ok: true, output };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown Composio error";
        logger.error(
          { err, toolName: input.toolName, userId: input.userId },
          `composio: executeTool failed — ${message}`,
        );
        return { ok: false, reason: "composio_error", message };
      }
    },

    async initiateConnection(input) {
      const body = {
        entityId: input.userId,
        appName: input.appName,
        redirectUri: input.redirectUri,
      };
      const raw = await composioFetch<{
        connectedAccountId?: string;
        connectionId?: string;
        redirectUrl?: string;
        redirect_url?: string;
      }>(deps, "/connectedAccounts/initiate", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const connectionId = raw.connectedAccountId ?? raw.connectionId ?? "";
      const redirectUrl = raw.redirectUrl ?? raw.redirect_url ?? "";
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
        connectionId?: string;
        status?: string;
        appName?: string;
        entityId?: string;
      }>(
        deps,
        `/connectedAccounts/${encodeURIComponent(params.connectionId)}`,
        { method: "GET" },
      );
      return {
        connectionId: raw.id ?? raw.connectionId ?? params.connectionId,
        status: normalizeConnectionStatus(raw.status),
        appName: raw.appName,
        entityId: raw.entityId,
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

// ─── Convenience — top-level executeTool that uses the singleton ─────────

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
