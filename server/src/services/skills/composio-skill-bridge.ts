/**
 * composio-skill-bridge — shared helper that lets each action-skill check
 * whether it should route through Composio for the current (company, user)
 * before falling back to the native OAuth + custom-client path.
 *
 * Contract:
 *   - `lookupConnection` returns the active composio_connections row for
 *     (companyId, userId, appName) or null when none exists.
 *   - `shouldUseComposio` is true only when Composio is enabled AND a row
 *     with `status = 'active'` is present for the given tuple. Pending /
 *     failed connections fall back to native (per Wave 21 design rule 1).
 *   - `executeViaComposio` invokes the singleton Composio client and maps
 *     its result onto the caller's own ResultShape. On any Composio-side
 *     error we return `{ ok: false, reason: "composio_error" }` — we do
 *     NOT silently dual-execute via native (Wave 21 design rule 2).
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import {
  getComposioClient,
  isComposioEnabled,
  type ComposioExecuteResult,
} from "../composio-client.js";

export interface ComposioRouteContext {
  db: Db;
  companyId: string;
  /** FounderOS user id — optional. When absent, Composio is NOT used. */
  userId?: string | null;
  appName: "slack" | "hubspot" | "notion" | "linkedin" | string;
}

/**
 * Discriminated union so callers get type-narrowing for free:
 *
 *   if (route.shouldUse) {
 *     // route.composioConnectionId: string  (guaranteed non-null)
 *   }
 *
 * Pre-2026-05-04, this was a single shape with `composioConnectionId: string | null`,
 * which let call sites forget to pass the id to runComposioTool. The Composio
 * v3 client picks an arbitrary connection when the user has the same app
 * connected in multiple orgs — agent in Org A could post to Org B Slack.
 * Encoding the invariant in the type forces every call site to provide the
 * org-scoped connection id.
 */
export type ComposioRouteDecision =
  | { shouldUse: true; composioConnectionId: string; composioEnabled: boolean }
  | { shouldUse: false; composioConnectionId: string | null; composioEnabled: boolean };

export async function evaluateComposioRoute(
  ctx: ComposioRouteContext,
): Promise<ComposioRouteDecision> {
  const composioEnabled = isComposioEnabled();
  if (!composioEnabled || !ctx.userId) {
    return { shouldUse: false, composioConnectionId: null, composioEnabled };
  }
  const [row] = await ctx.db
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.companyId, ctx.companyId),
        eq(composioConnections.userId, ctx.userId),
        eq(composioConnections.appName, ctx.appName),
      ),
    );
  if (!row || row.status !== "active") {
    return {
      shouldUse: false,
      composioConnectionId: row?.composioConnectionId ?? null,
      composioEnabled,
    };
  }
  return {
    shouldUse: true,
    composioConnectionId: row.composioConnectionId,
    composioEnabled,
  };
}

/**
 * Invoke a Composio tool via the singleton client. Returns the raw
 * `ComposioExecuteResult` so each skill can shape it into its own typed
 * result. Never throws — errors become `{ ok: false, reason }`.
 *
 * Council 2026-05-04: `connectedAccountId` is REQUIRED. Composio v3
 * `executeTool({ userId })` without it picks an arbitrary connection
 * when the user has the same app connected in multiple orgs — that's
 * the cross-org privilege escalation CVE. Always pass the
 * org-scoped connection id from `evaluateComposioRoute`'s `shouldUse: true`
 * branch (the type narrowing guarantees it's a string at the call site).
 */
export async function runComposioTool(params: {
  userId: string;
  connectedAccountId: string;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<ComposioExecuteResult> {
  const client = getComposioClient();
  if (!client) {
    return {
      ok: false,
      reason: "not_enabled",
      message: "Composio is not enabled",
    };
  }
  return client.executeTool({
    userId: params.userId,
    connectedAccountId: params.connectedAccountId,
    toolName: params.toolName,
    params: params.input,
  });
}
