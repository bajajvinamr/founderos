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
