/**
 * composio-connection-resolver.ts — S4.8 prerequisite #198.
 *
 * Closes the council 2026-05-06 finding #4 P1 BLOCK #5: "Cross-org HubSpot
 * leak via Composio. composio-client.ts:130 defaults to 'Composio selects an
 * active connected account'. Multi-org admin approves Org A's rescue → deploys
 * to Org B's HubSpot. Need typed (non-optional) connectedAccountId in
 * churn-rescue path, resolved at run creation, persisted on approval payload."
 *
 * The composio-skill-bridge.ts already enforces a required `connectedAccountId`
 * at the bridge layer (council 2026-05-04 fix). What was missing: a SHARED
 * resolver that customer-facing workflows (churn-rescue first, others later)
 * use to deterministically resolve the per-company connection for a given app
 * — and FAIL LOUDLY when none exists rather than fall through to "Composio
 * picks one".
 *
 * ## Resolution rules
 *
 * Inputs: companyId + appName (e.g. "hubspot", "slack").
 * Lookups (in priority order):
 *   1. Active connection for this company + app → return its composioConnectionId
 *   2. Pending/failed connection for this company + app → throw with status hint
 *   3. No row at all → throw "no connection configured"
 *
 * The userId field on composio_connections is per-OAuth-flow; for workflow-run
 * use we don't filter on it (any active company+app connection is acceptable;
 * the founder owns all of them). Future per-user channel scoping would tighten
 * this.
 *
 * ## Why this isn't on composio-client itself
 *
 * composio-client is the low-level v3 REST wrapper. It accepts an OPTIONAL
 * connectedAccountId because some Composio surfaces (read-only catalogs,
 * platform-scope calls) legitimately don't need one. Customer-facing
 * autonomous templates (churn-rescue, future autonomous CRM templates) MUST
 * resolve through this resolver — that's the boundary.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";

/**
 * Active per-company Composio connection — both the OAuth-scoped FounderOS
 * userId AND the org-scoped composio connection id, resolved together.
 *
 * Per-user routing context: Composio v3 `executeTool({ userId, connectedAccountId })`
 * uses `userId` for OAuth scoping (which person's Gmail/Slack/LinkedIn the
 * call posts "as") and `connectedAccountId` for the org-scoped credential.
 * Pre-2026-05-04, `connectedAccountId` was optional and `userId: ""` was
 * silently accepted — Composio would then "pick any account for this user".
 * The cross-org leak (PR #30) closed the connectedAccountId side; this
 * resolver closes the userId side for jobs that run on behalf of a
 * company's owning user (e.g. the content-publish-tick scheduler that
 * posts approved drafts on the founder's behalf).
 */
export interface ComposioActiveConnection {
  /** FounderOS user id that owns the OAuth flow — required for Composio routing. */
  userId: string;
  /** Org-scoped Composio connection id — required for cross-org leak defense. */
  connectedAccountId: string;
}

export class ComposioConnectionMissingError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly appName: string,
    public readonly status: "missing" | "pending" | "failed" | "revoked",
    public readonly composioConnectionId?: string,
  ) {
    super(
      `composio-connection-resolver: company ${companyId} has no usable ${appName} connection ` +
        `(status=${status}). Customer-facing autonomous templates must NOT proceed without ` +
        `a typed connectedAccountId — the alternative ('Composio picks one') is the cross-org leak ` +
        `the council 2026-05-06 #4 BLOCKed.`,
    );
    this.name = "ComposioConnectionMissingError";
  }
}

/**
 * resolveConnectedAccountId — primary resolver.
 *
 * Returns the composioConnectionId for the company+app pair when an ACTIVE
 * connection exists. Throws ComposioConnectionMissingError otherwise — never
 * returns null/undefined. Callers that want to gracefully handle missing
 * connections should catch the error explicitly.
 */
export async function resolveConnectedAccountId(
  db: Db,
  companyId: string,
  appName: string,
): Promise<string> {
  // Prefer the active connection. If multiple active rows exist (multiple
  // founder OAuth flows for the same app), pick the most recent — but log a
  // warning since this is unusual and could indicate stale rows.
  const rows = await db
    .select({
      id: composioConnections.id,
      composioConnectionId: composioConnections.composioConnectionId,
      status: composioConnections.status,
      updatedAt: composioConnections.updatedAt,
    })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.companyId, companyId),
        eq(composioConnections.appName, appName),
      ),
    );

  if (rows.length === 0) {
    throw new ComposioConnectionMissingError(companyId, appName, "missing");
  }

  const active = rows.filter((r) => r.status === "active");
  if (active.length > 0) {
    // Most-recently-updated active row wins.
    active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return active[0].composioConnectionId;
  }

  // No active row — surface the most informative status to the caller.
  // Priority: pending > failed > revoked (pending = founder is mid-OAuth;
  // failed = retry-able; revoked = need re-grant).
  const byStatus = (s: string) => rows.find((r) => r.status === s);
  const pending = byStatus("pending");
  if (pending) {
    throw new ComposioConnectionMissingError(
      companyId,
      appName,
      "pending",
      pending.composioConnectionId,
    );
  }
  const failed = byStatus("failed");
  if (failed) {
    throw new ComposioConnectionMissingError(
      companyId,
      appName,
      "failed",
      failed.composioConnectionId,
    );
  }
  const revoked = byStatus("revoked");
  if (revoked) {
    throw new ComposioConnectionMissingError(
      companyId,
      appName,
      "revoked",
      revoked.composioConnectionId,
    );
  }

  // Unknown status (DB CHECK should prevent this; defensive fallback).
  throw new ComposioConnectionMissingError(companyId, appName, "missing");
}

/**
 * tryResolveConnectedAccountId — non-throwing variant.
 *
 * Returns null when no usable connection exists. Useful for UI surfaces that
 * need to render "Connect HubSpot" buttons rather than throw.
 */
export async function tryResolveConnectedAccountId(
  db: Db,
  companyId: string,
  appName: string,
): Promise<string | null> {
  try {
    return await resolveConnectedAccountId(db, companyId, appName);
  } catch (err) {
    if (err instanceof ComposioConnectionMissingError) return null;
    throw err;
  }
}

/**
 * resolveActiveConnection — both-fields variant for per-user routing.
 *
 * Returns the active `{ userId, connectedAccountId }` tuple for (companyId,
 * appName). Throws `ComposioConnectionMissingError` if no active connection
 * exists. Throws a plain `Error` (not the typed variant — this is a data
 * integrity bug, not a user-visible state) if the row exists but has an
 * empty/whitespace userId or connectedAccountId.
 *
 * Used by company-scoped background jobs (content-publish-tick) that need
 * to post on behalf of a tenant without an interactive request context.
 * The OAuth-scoped userId is critical: Composio uses it to identify which
 * person's account performs the post (Gmail "send as me", LinkedIn "post
 * as me"). Passing `""` silently downgrades to "any account for any user",
 * the same class as the cross-org leak PR #30 closed.
 */
export async function resolveActiveConnection(
  db: Db,
  companyId: string,
  appName: string,
): Promise<ComposioActiveConnection> {
  const rows = await db
    .select({
      userId: composioConnections.userId,
      composioConnectionId: composioConnections.composioConnectionId,
      status: composioConnections.status,
      updatedAt: composioConnections.updatedAt,
    })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.companyId, companyId),
        eq(composioConnections.appName, appName),
      ),
    );

  if (rows.length === 0) {
    throw new ComposioConnectionMissingError(companyId, appName, "missing");
  }

  const active = rows.filter((r) => r.status === "active");
  if (active.length === 0) {
    // Same status-priority surface as resolveConnectedAccountId.
    const byStatus = (s: string) => rows.find((r) => r.status === s);
    const pending = byStatus("pending");
    if (pending) {
      throw new ComposioConnectionMissingError(
        companyId,
        appName,
        "pending",
        pending.composioConnectionId,
      );
    }
    const failed = byStatus("failed");
    if (failed) {
      throw new ComposioConnectionMissingError(
        companyId,
        appName,
        "failed",
        failed.composioConnectionId,
      );
    }
    const revoked = byStatus("revoked");
    if (revoked) {
      throw new ComposioConnectionMissingError(
        companyId,
        appName,
        "revoked",
        revoked.composioConnectionId,
      );
    }
    throw new ComposioConnectionMissingError(companyId, appName, "missing");
  }

  // Most-recently-updated active row wins.
  active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const winner = active[0]!;

  // Data-integrity guard: an active row with an empty userId or
  // connectedAccountId is a structural bug (schema is NOT NULL but
  // application code could insert "" or whitespace). Fail loud here so the
  // job-level fail-fast guard isn't the only defense.
  const userId = winner.userId?.trim() ?? "";
  const connectedAccountId = winner.composioConnectionId?.trim() ?? "";
  if (userId.length === 0) {
    throw new Error(
      `composio-connection-resolver: active ${appName} connection for company ${companyId} ` +
        `has an empty userId. This is a data-integrity bug; refusing to call Composio ` +
        `with userId: "" (would silently route to an arbitrary account).`,
    );
  }
  if (connectedAccountId.length === 0) {
    throw new Error(
      `composio-connection-resolver: active ${appName} connection for company ${companyId} ` +
        `has an empty composio_connection_id. Reconnect the integration.`,
    );
  }

  return { userId, connectedAccountId };
}

/**
 * tryResolveActiveConnection — non-throwing variant of resolveActiveConnection.
 *
 * Returns `null` only for `ComposioConnectionMissingError` (the
 * "no usable row" signal). Data-integrity errors (empty userId / connection
 * id on an active row) re-throw — those are bugs, not user-visible state.
 */
export async function tryResolveActiveConnection(
  db: Db,
  companyId: string,
  appName: string,
): Promise<ComposioActiveConnection | null> {
  try {
    return await resolveActiveConnection(db, companyId, appName);
  } catch (err) {
    if (err instanceof ComposioConnectionMissingError) return null;
    throw err;
  }
}
