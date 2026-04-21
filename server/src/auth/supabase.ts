/**
 * Supabase authentication adapter.
 *
 * Wave 13A — replaces better-auth for hosted FounderOS deployments. Users
 * sign in via Supabase (email+password or Google OAuth) on the client; the
 * client sends either:
 *   - `Authorization: Bearer <supabase-access-token>` (API clients), or
 *   - the `sb-access-token` cookie (set by Supabase SSR client).
 *
 * The server validates the JWT **locally** using the shared `SUPABASE_JWT_SECRET`
 * (Supabase's legacy symmetric HS256 project JWT secret). No round-trip to
 * Supabase Auth is needed for each request — this is a stateless, ~microsecond
 * verification.
 *
 * Webhook path: Supabase Auth fires `user.created` / `user.updated` events
 * into our `/api/auth/webhook` endpoint. We verify the signature via a shared
 * `SUPABASE_WEBHOOK_SECRET` (HMAC-SHA256 over the raw body) and then run the
 * shared `runPostSignupBootstrap(...)` — same first-user-wins + invite-consume
 * logic better-auth already uses.
 *
 * Exposes the same `BetterAuthSessionResult` shape downstream so the existing
 * `req.actor` middleware is a drop-in swap at the resolver layer.
 */

import type { Request } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { jwtVerify, createRemoteJWKSet, errors as joseErrors } from "jose";
import type { BetterAuthSessionResult } from "./better-auth.js";
import { logger } from "../middleware/logger.js";

export type SupabaseConfig = {
  /** e.g. `https://abcd.supabase.co` — required; JWKS endpoint derived from it. */
  url?: string;
  /** Anon (public) key — safe to ship to browsers. */
  anonKey?: string;
  /** Service role key — server-only. Never return in any API response. */
  serviceRoleKey?: string;
  /**
   * Legacy HS256 JWT secret. Optional — used only as a fallback for older
   * projects that issue symmetric tokens. Modern projects issue ES256
   * tokens verified via JWKS (no shared secret needed).
   */
  jwtSecret?: string;
  /** Shared HMAC secret for verifying inbound Supabase webhook calls. */
  webhookSecret?: string;
};

export type SupabaseUser = {
  id: string;
  email: string | null;
  name: string | null;
  /** `email`, `google`, `github`, ... — extracted from `app_metadata.provider`. */
  provider: string | null;
};

export interface SupabaseAuthInstance {
  config: SupabaseConfig;
  /** JWKS fetcher for ES256/RS256 asymmetric tokens. */
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  /** Fallback HS256 secret bytes (legacy projects only). */
  jwtSecretBytes: Uint8Array | null;
}

const SUPABASE_COOKIE_NAME = "sb-access-token";
/** Algorithms accepted. Modern Supabase uses ES256 via JWKS; HS256 is legacy. */
const SUPABASE_ALGORITHMS = ["ES256", "RS256", "HS256"] as const;
/** Supabase Auth always uses this audience for end-user access tokens. */
const SUPABASE_AUDIENCE = "authenticated";

export function createSupabaseAuth(config: SupabaseConfig): SupabaseAuthInstance {
  const jwks = config.url
    ? createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", config.url))
    : null;
  return {
    config,
    jwks,
    jwtSecretBytes: config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : null,
  };
}

export function isSupabaseConfigured(config: SupabaseConfig): boolean {
  // Minimum requirement: SUPABASE_URL (for JWKS endpoint). Modern projects
  // verify ES256 tokens via JWKS — no secret needed. Legacy HS256 secret is
  // accepted as fallback when configured.
  return Boolean(config.url && config.url.trim().length > 0);
}

/**
 * Extract the Supabase access token from the request. Precedence:
 *   1. `Authorization: Bearer <token>` header (API clients, mobile apps)
 *   2. `sb-access-token` cookie (browser Supabase SSR client)
 *
 * Returns `null` if no token is present.
 */
export function extractSupabaseToken(req: Request): string | null {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (token) return token;
  }

  const cookieHeader = req.header("cookie");
  if (cookieHeader) {
    const token = parseCookieValue(cookieHeader, SUPABASE_COOKIE_NAME);
    if (token) return token;
  }

  return null;
}

export function extractSupabaseTokenFromHeaders(rawHeaders: IncomingHttpHeaders | Headers): string | null {
  const get = (name: string): string | null => {
    if (rawHeaders instanceof Headers) return rawHeaders.get(name);
    const raw = rawHeaders[name.toLowerCase()];
    if (!raw) return null;
    if (Array.isArray(raw)) return raw[0] ?? null;
    return raw;
  };

  const auth = get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    if (token) return token;
  }

  const cookie = get("cookie");
  if (cookie) {
    const token = parseCookieValue(cookie, SUPABASE_COOKIE_NAME);
    if (token) return token;
  }

  return null;
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  // Intentionally lightweight — we don't need full RFC 6265 parsing, and we
  // don't want a dependency on `cookie` for a single lookup.
  const parts = cookieHeader.split(";");
  for (const raw of parts) {
    const trimmed = raw.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

/**
 * Verify a Supabase access token and return the session+user in the shape
 * used by the rest of the server. Returns `null` for any failure mode
 * (missing secret, malformed token, bad signature, expired, wrong issuer,
 * etc.). Specific failure reasons are logged at DEBUG — `req.actor` stays
 * unauthenticated regardless.
 */
export async function verifySupabaseJwt(
  auth: SupabaseAuthInstance,
  token: string,
): Promise<BetterAuthSessionResult | null> {
  if (!token) return null;
  if (!auth.jwks && !auth.jwtSecretBytes) {
    logger.warn("verifySupabaseJwt called without SUPABASE_URL or SUPABASE_JWT_SECRET configured");
    return null;
  }

  const verifyOpts: Parameters<typeof jwtVerify>[2] = {
    algorithms: [...SUPABASE_ALGORITHMS],
    audience: SUPABASE_AUDIENCE,
  };
  if (auth.config.url) {
    verifyOpts.issuer = new URL("/auth/v1", auth.config.url).toString();
  }

  let payload: Record<string, unknown> | null = null;
  let lastErr: unknown = null;

  // Try JWKS (ES256/RS256) first — the default for modern Supabase projects.
  if (auth.jwks) {
    try {
      const result = await jwtVerify(token, auth.jwks, verifyOpts);
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback: HS256 shared secret for legacy projects.
  if (!payload && auth.jwtSecretBytes) {
    try {
      const result = await jwtVerify(token, auth.jwtSecretBytes, verifyOpts);
      payload = result.payload as Record<string, unknown>;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!payload) {
    if (lastErr instanceof joseErrors.JOSEError) {
      logger.debug({ code: lastErr.code, name: lastErr.name }, "supabase JWT verify failed");
    } else if (lastErr) {
      logger.debug({ err: lastErr }, "supabase JWT verify failed (unknown error)");
    }
    return null;
  }

  const user = extractSupabaseUserFromClaims(payload);
  if (!user) return null;

  return {
    session: { id: `supabase:${user.id}`, userId: user.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  };
}

/**
 * Extract a FounderOS-shaped user from Supabase JWT claims. Returns `null`
 * if required claims (`sub`) are missing or malformed.
 */
export function extractSupabaseUserFromClaims(
  payload: Record<string, unknown>,
): SupabaseUser | null {
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) return null;

  const email =
    typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null;

  const userMetadata =
    payload.user_metadata && typeof payload.user_metadata === "object"
      ? (payload.user_metadata as Record<string, unknown>)
      : {};
  const appMetadata =
    payload.app_metadata && typeof payload.app_metadata === "object"
      ? (payload.app_metadata as Record<string, unknown>)
      : {};

  const rawName =
    (typeof userMetadata.name === "string" && userMetadata.name) ||
    (typeof userMetadata.full_name === "string" && userMetadata.full_name) ||
    null;
  const name = rawName && rawName.trim().length > 0 ? rawName : null;

  const provider =
    typeof appMetadata.provider === "string" && appMetadata.provider.length > 0
      ? appMetadata.provider
      : null;

  return { id: sub, email, name, provider };
}

/**
 * Verify an inbound Supabase Auth webhook signature. Supabase signs requests
 * with HMAC-SHA256 over the raw request body. The expected header format is
 * `sha256=<hex>` (lowercase). Returns `true` when the signature matches,
 * `false` for any shape/secret mismatch.
 *
 * Constant-time compare via `timingSafeEqual`.
 */
export function verifySupabaseWebhookSignature(input: {
  rawBody: Buffer | string;
  signatureHeader: string | null | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader || !input.secret) return false;

  const normalized = input.signatureHeader.trim().toLowerCase();
  const hexSignature = normalized.startsWith("sha256=")
    ? normalized.slice("sha256=".length)
    : normalized;
  if (!/^[0-9a-f]+$/.test(hexSignature)) return false;

  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  const expected = createHmac("sha256", input.secret).update(body).digest("hex");

  const provided = Buffer.from(hexSignature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (provided.length !== expectedBuf.length) return false;
  return timingSafeEqual(provided, expectedBuf);
}

/**
 * Normalize the record payload inside a Supabase webhook event into the
 * shape the post-signup bootstrap expects. Returns `null` if required
 * fields are missing.
 *
 * Supabase webhook payload shape (user events):
 *   {
 *     type: "user.created",
 *     record: { id: "<uuid>", email: "...", user_metadata: {...}, ... },
 *     old_record?: {...},
 *   }
 */
export function extractSupabaseUserFromWebhook(
  payload: unknown,
): { id: string; email: string; name: string | null; provider: string | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== "object") return null;

  const r = record as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const email = typeof r.email === "string" && r.email.length > 0 ? r.email : null;
  if (!id || !email) return null;

  const userMetadata =
    r.user_metadata && typeof r.user_metadata === "object"
      ? (r.user_metadata as Record<string, unknown>)
      : {};
  const appMetadata =
    r.app_metadata && typeof r.app_metadata === "object"
      ? (r.app_metadata as Record<string, unknown>)
      : {};

  const rawName =
    (typeof userMetadata.name === "string" && userMetadata.name) ||
    (typeof userMetadata.full_name === "string" && userMetadata.full_name) ||
    null;
  const name = rawName && rawName.trim().length > 0 ? rawName : null;

  const provider =
    typeof appMetadata.provider === "string" && appMetadata.provider.length > 0
      ? appMetadata.provider
      : null;

  return { id, email, name, provider };
}

/**
 * High-level session resolver used by `actorMiddleware`. Same shape as the
 * better-auth and Clerk resolvers so the downstream code doesn't care which
 * provider is wired.
 */
export async function resolveSupabaseSession(
  auth: SupabaseAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  const token = extractSupabaseToken(req);
  if (!token) return null;
  return verifySupabaseJwt(auth, token);
}

export async function resolveSupabaseSessionFromHeaders(
  auth: SupabaseAuthInstance,
  headers: Headers | IncomingHttpHeaders,
): Promise<BetterAuthSessionResult | null> {
  const token = extractSupabaseTokenFromHeaders(headers);
  if (!token) return null;
  return verifySupabaseJwt(auth, token);
}
