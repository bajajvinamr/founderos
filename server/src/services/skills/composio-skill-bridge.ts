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

export interface ComposioRouteDecision {
  /** True iff we should execute via Composio. */
  shouldUse: boolean;
  /** The active Composio connection id, if any. */
  composioConnectionId: string | null;
  /** True iff Composio is enabled globally (regardless of a connection). */
  composioEnabled: boolean;
}

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
 */
export async function runComposioTool(params: {
  userId: string;
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
    toolName: params.toolName,
    params: params.input,
  });
}
