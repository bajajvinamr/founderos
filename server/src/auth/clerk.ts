/**
 * Clerk authentication adapter.
 *
 * Exposes the same `AuthSessionResult` shape that better-auth uses so the
 * rest of the server (middleware/auth.ts, routes, websockets) doesn't care
 * which provider is wired up — it just calls `resolveSession(req)`.
 *
 * Activation: set both env vars before boot
 *    CLERK_SECRET_KEY=sk_live_...
 *    CLERK_PUBLISHABLE_KEY=pk_live_...
 *
 * The UI reads the publishable key from /api/auth/config.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";
import { createClerkClient, type ClerkClient } from "@clerk/backend";
import type { BetterAuthSessionResult } from "./better-auth.js";

export type ClerkAuthInstance = {
  client: ClerkClient;
  publishableKey: string;
};

export function isClerkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CLERK_SECRET_KEY?.trim().length && env.CLERK_PUBLISHABLE_KEY?.trim().length,
  );
}

export function createClerkAuth(
  env: NodeJS.ProcessEnv = process.env,
): ClerkAuthInstance {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim();
  if (!secretKey || !publishableKey) {
    throw new Error(
      "createClerkAuth called without CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY",
    );
  }
  return {
    client: createClerkClient({ secretKey, publishableKey }),
    publishableKey,
  };
}

/**
 * Collect headers in the exact shape Clerk's `authenticateRequest` expects.
 * We keep this identical to how better-auth reads them so the two adapters
 * can be hot-swapped at boot time.
 */
function webHeadersFromNode(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function buildWebRequest(req: Request): Request & { url: string } {
  // Clerk.authenticateRequest wants a Fetch Request. Express req is close
  // enough but we need a stable URL + Headers. Construct a minimal stand-in.
  const headers = webHeadersFromNode(req.headers);
  const host = req.headers.host ?? "localhost";
  const protocol = req.protocol || "http";
  const url = `${protocol}://${host}${req.originalUrl ?? req.url ?? "/"}`;
  const webRequest = new globalThis.Request(url, { headers });
  return webRequest as unknown as Request & { url: string };
}

export async function resolveClerkSession(
  auth: ClerkAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  try {
    const webReq = buildWebRequest(req);
    const requestState = await auth.client.authenticateRequest(webReq as unknown as globalThis.Request, {
      authorizedParties: deriveAuthorizedParties(req),
    });
    if (!requestState.isSignedIn) return null;
    const toAuth = (requestState as { toAuth?: () => { userId?: string; sessionId?: string } }).toAuth;
    const claims = toAuth ? toAuth() : { userId: undefined, sessionId: undefined };
    if (!claims.userId || !claims.sessionId) return null;

    // Pull richer user info for email/name
    const user = await auth.client.users.getUser(claims.userId).catch(() => null);
    return {
      session: { id: claims.sessionId, userId: claims.userId },
      user: {
        id: claims.userId,
        email: user?.emailAddresses?.[0]?.emailAddress ?? null,
        name: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null,
      },
    };
  } catch {
    // Bad token, expired session, etc. → treat as unauthenticated.
    return null;
  }
}

/**
 * The `Origin` + `Host` that Clerk should trust. Derived from the request so
 * the dev tunnel + localhost both work without additional config.
 */
function deriveAuthorizedParties(req: Request): string[] {
  const parties = new Set<string>();
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) parties.add(origin);
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0) {
    const proto = req.protocol || "http";
    parties.add(`${proto}://${host}`);
  }
  return Array.from(parties);
}
