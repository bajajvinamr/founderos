/**
 * billing-gate.ts — server-side plan-tier enforcement.
 *
 * The 2026-05-03 council BLOCK on billing flagged client-only enforcement:
 * the UI's <BillingGate> polls /api/billing/status and refuses to render
 * children when inactive — but a sufficiently motivated user can bypass
 * the gate in DevTools and continue hitting LLM-cost endpoints. This
 * middleware enforces the same gate server-side so the cost surface is
 * actually closed.
 *
 * Mounted on LLM-cost endpoints (/agents/:id/wakeup, /heartbeat/invoke)
 * — the routes where "free tier abuse" translates directly to USD spend
 * on Anthropic. Read-only and settings routes are NOT gated; the goal
 * is to stop the spend, not to lock founders out of their own dashboard.
 *
 * Soft-default: the gate is OPT-IN via FOUNDEROS_BILLING_GATE_ENABLED=1.
 * When unset, requests pass through and the middleware logs once per
 * boot that the gate is disabled. This lets the data-integrity layer
 * (migration 0074, idempotent webhook) ship to production first; flip
 * the flag once Stripe webhook traffic confirms subscriptions are being
 * recorded correctly.
 *
 * Bypasses (always allowed even when gate is on):
 *   - Local trusted mode (founder self-host): no Stripe relationship
 *     to enforce against; gating their own laptop would be absurd.
 *   - Instance admins: support / debugging access takes precedence.
 *
 * Notably NOT bypassed: agent-typed actors. Subscriptions are instance-
 * level (one row in `instance_subscription` per Fly app), so an agent
 * recursively invoking itself draws from the same pool as the founder
 * clicking the wakeup button. If the instance is inactive, ALL LLM
 * calls stop — agent or board, same gate.
 */

import type { Request, Response, NextFunction } from "express";
import type { Db } from "@founderos/db";
import { subscriptionService } from "../services/subscription.js";
import { logger } from "./logger.js";
import { getRequestId } from "../lib/request-context.js";

let _bootBannerLogged = false;

export function isBillingGateEnabled(): boolean {
  const v = (process.env.FOUNDEROS_BILLING_GATE_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface BillingGateOptions {
  /**
   * Override the active-check resolver. Tests inject a stub here so they
   * don't have to spin up an embedded Postgres just to assert the 402
   * branch. Production wires this to subscriptionService(db).isSubscriptionActive.
   */
  isActive?: () => Promise<boolean>;
}

/**
 * Express middleware: refuses LLM-cost requests when the instance has
 * no active subscription. Returns 402 Payment Required (the canonical
 * status for billing-related blocks; some browsers handle it specially
 * but most just surface it as an error which is what we want here).
 */
export function billingGate(db: Db, opts: BillingGateOptions = {}) {
  const enabled = isBillingGateEnabled();
  if (!_bootBannerLogged) {
    if (enabled) {
      logger.info("Billing gate ENABLED — LLM-cost endpoints will 402 for inactive subs");
    } else {
      logger.info(
        "Billing gate DISABLED — set FOUNDEROS_BILLING_GATE_ENABLED=1 to enforce server-side",
      );
    }
    _bootBannerLogged = true;
  }
  const isActive =
    opts.isActive ?? (() => subscriptionService(db).isSubscriptionActive());

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enabled) {
      next();
      return;
    }

    // Bypass for actors that don't have a Stripe relationship.
    const actor = req.actor;
    if (!actor) {
      // No actor resolved yet — let downstream auth middleware decide.
      // (This middleware sits AFTER actorMiddleware in the route chain
      // so a missing actor here is anomalous; pass through and let the
      // route's own assertions reject with 401.)
      next();
      return;
    }
    if (actor.source === "local_implicit") {
      next();
      return;
    }
    if (actor.isInstanceAdmin) {
      next();
      return;
    }

    try {
      const active = await isActive();
      if (active) {
        next();
        return;
      }
    } catch (err) {
      logger.error(
        { err, actorUserId: actor.userId },
        "billing-gate: isSubscriptionActive threw — failing CLOSED",
      );
      // Fail CLOSED on error: an exception on the lookup path is the
      // exact failure mode an attacker would try to provoke. Returning
      // 402 here is safer than fail-open. The UI's loading state will
      // surface this as a billing block, the founder reaches support,
      // we fix the underlying error.
    }

    const requestId = getRequestId();
    res.status(402).json({
      error: "subscription_inactive",
      message:
        "An active subscription is required for this action. Visit /settings/billing to upgrade.",
      requestId: requestId ?? null,
    });
  };
}
