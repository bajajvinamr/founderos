/**
 * OAuth 3-legged flow — start + callback.
 *
 * GET /api/oauth/:kind/start?companyId=...&returnUrl=...
 * GET /api/oauth/:kind/callback?code=...&state=...
 */

import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { Db } from "@founderos/db";
import {
  getOAuthProvider,
  isOAuthKind,
  signOAuthState,
  verifyOAuthState,
} from "../services/oauth/index.js";
import { integrationService } from "../services/integrations.js";
import { syncHubspot } from "../services/hubspot-sync.js";
import { createSlackClient } from "../services/slack-client.js";
import { assertCompanyAccess } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { integrations } from "@founderos/db";
import { and, eq } from "drizzle-orm";

function getPublicUrl(): string {
  return (process.env.FOUNDEROS_PUBLIC_URL ?? "").replace(/\/$/, "");
}

/**
 * Validate that a returnUrl is a same-origin path. Rejects absolute URLs,
 * protocol-relative URLs (`//evil.com/path`), URL schemes, Windows-style
 * paths, header-injection (CR/LF), and missing/empty input. Falls back to
 * `"/"` on any reject — graceful degradation, no throw.
 *
 * Closes CodeQL `js/server-side-unvalidated-url-redirection` (cluster P,
 * alerts #7-#10): without validation, an attacker-controlled `returnUrl`
 * could leak the OAuth `code` to an external origin via Referer.
 */
export function validateReturnUrl(raw: string | undefined): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "/";
  // Reject header-injection (CR/LF) before further checks.
  if (/[\r\n]/.test(trimmed)) return "/";
  // Reject Windows-style backslash paths (parsed as `\\evil.com\path` by some
  // clients into a protocol-relative redirect).
  if (trimmed.includes("\\")) return "/";
  // Reject URL schemes like `javascript:`, `https:`, `data:` etc.
  // Pattern: leading letters (alphanum + `+-.`) followed by `:`.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return "/";
  // Must start with `/` AND not start with `//` (protocol-relative redirect).
  if (!trimmed.startsWith("/")) return "/";
  if (trimmed.startsWith("//")) return "/";
  return trimmed;
}

export function oauthRoutes(db: Db) {
  const router = Router();
  const svc = integrationService(db);

  /**
   * GET /api/oauth/:kind/start?companyId=...&returnUrl=...
   * Redirects user to the provider's authorization page.
   */
  router.get("/oauth/:kind/start", (req, res) => {
    const { kind } = req.params as { kind: string };
    const companyId = req.query.companyId as string | undefined;
    // Validate at sign-time so we never embed an attacker-controlled URL into
    // the signed state. Defaults to "/integrations" when missing/empty/invalid.
    const rawReturnUrl = req.query.returnUrl as string | undefined;
    const returnUrl = rawReturnUrl && rawReturnUrl.trim().length > 0
      ? validateReturnUrl(rawReturnUrl)
      : "/integrations";

    if (!isOAuthKind(kind)) {
      res.status(400).json({ error: "unknown_kind", kind });
      return;
    }

    if (!companyId) {
      res.status(400).json({ error: "missing_companyId" });
      return;
    }

    try {
      assertCompanyAccess(req, companyId);
    } catch {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    // Council 2026-05-03 P2 (Gemini R2) — bind userId to OAuth state.
    // Without this, the signed state was a transferable capability:
    // attacker initiates flow for own companyId, gets a valid state,
    // tricks victim admin into clicking the authorize URL, victim
    // authenticates with their provider account, callback links the
    // victim's external account against the attacker's companyId.
    // Now /callback enforces req.actor.userId === payload.userId before
    // upserting the integration row.
    const initiatorUserId = req.actor.userId;
    if (!initiatorUserId) {
      // No userId on the actor → not a board/session principal. Refuse to
      // sign a state we can't validate later. Local-trusted has a userId
      // ("local-board") so this only fires for unauthenticated/agent flows.
      res.status(401).json({ error: "oauth_requires_user_session" });
      return;
    }

    const provider = getOAuthProvider(kind);

    if (!provider.isConfigured()) {
      res.status(503).json({
        error: "oauth_not_configured",
        kind,
        message: `Set ${provider.clientIdEnv} and ${provider.clientSecretEnv} to enable OAuth for ${kind}`,
      });
      return;
    }

    const nonce = randomBytes(16).toString("hex");
    const issuedAt = Math.floor(Date.now() / 1000);

    const state = signOAuthState({
      userId: initiatorUserId,
      companyId,
      kind,
      returnUrl,
      nonce,
      issuedAt,
    });

    const redirectUri = `${getPublicUrl()}/api/oauth/${kind}/callback`;
    const authorizeUrl = provider.buildAuthorizeUrl({
      redirectUri,
      state,
      clientId: provider.getClientId(),
    });

    res.redirect(302, authorizeUrl);
  });

  /**
   * GET /api/oauth/:kind/callback?code=...&state=...
   * Exchanges code for token, upserts integration row, redirects back.
   */
  router.get("/oauth/:kind/callback", async (req, res) => {
    const { kind } = req.params as { kind: string };
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!isOAuthKind(kind)) {
      res.status(400).json({ error: "unknown_kind", kind });
      return;
    }

    if (!state) {
      res.status(400).json({ error: "missing_state" });
      return;
    }

    // Verify state
    const stateResult = verifyOAuthState(state);
    if (!stateResult.ok) {
      const fallback = "/integrations";
      res.redirect(302, `${fallback}?oauth_error=${stateResult.reason}`);
      return;
    }

    const { userId: stateUserId, companyId, returnUrl: rawReturnUrl } = stateResult.payload;
    // Defense in depth: even though state is HMAC-signed, validate again at
    // the redirect boundary. If anything ever bypasses sign-time validation
    // (alternative state flows, future code paths), we still reject open
    // redirects here. CodeQL js/server-side-unvalidated-url-redirection.
    const returnUrl = validateReturnUrl(rawReturnUrl);

    // Council 2026-05-03 P2 (Gemini R2) — enforce that the user completing
    // the callback is the same one that initiated the flow. Without this
    // check, a leaked authorize URL is a transferable capability: attacker
    // hands the URL to a victim admin of the target SaaS, victim
    // authenticates with their provider account, callback would otherwise
    // upsert the victim's external account against the attacker's
    // companyId.
    const callbackUserId = req.actor.userId;
    if (!callbackUserId || callbackUserId !== stateUserId) {
      logger.warn(
        { kind, stateUserId, callbackUserId, companyId },
        "oauth callback: user mismatch — refusing to upsert integration",
      );
      res.redirect(302, `${returnUrl}?oauth_error=user_mismatch`);
      return;
    }

    if (!code) {
      res.redirect(302, `${returnUrl}?oauth_error=missing_code`);
      return;
    }

    const provider = getOAuthProvider(kind);
    const redirectUri = `${getPublicUrl()}/api/oauth/${kind}/callback`;

    // Exchange code for token
    let accessToken: string;
    try {
      const result = await provider.exchangeCode({ code, redirectUri });
      accessToken = result.accessToken;
    } catch (err: unknown) {
      logger.error({ err, kind }, "oauth token exchange failed");
      res.redirect(302, `${returnUrl}?oauth_error=token_exchange_failed`);
      return;
    }

    // Upsert integration row
    let integrationId: string;
    try {
      const integration = await svc.create(companyId, {
        kind,
        apiKey: accessToken,
      });
      integrationId = integration.id;
    } catch (err: unknown) {
      logger.error({ err, kind, companyId }, "oauth integration upsert failed");
      res.redirect(302, `${returnUrl}?oauth_error=upsert_failed`);
      return;
    }

    // Fire-and-forget post-connect syncs
    if (kind === "hubspot") {
      void syncHubspot({
        db,
        integrationId,
        companyId,
        decryptedApiKey: accessToken,
      }).catch((err: unknown) => {
        logger.error({ err, integrationId }, "hubspot-sync after oauth failed");
      });
    }

    if (kind === "slack") {
      void (async () => {
        try {
          const client = createSlackClient({ botToken: accessToken });
          const channels = await client.listChannels();
          const accessible = channels.filter((ch) => ch.isMember);
          const channelsList = accessible.slice(0, 20).map((ch) => ({
            id: ch.id,
            name: ch.name,
            isPrivate: ch.isPrivate,
          }));
          await db
            .update(integrations)
            .set({ config: { channels: channelsList }, updatedAt: new Date() })
            .where(
              and(
                eq(integrations.id, integrationId),
                eq(integrations.companyId, companyId),
              ),
            );
        } catch (err: unknown) {
          logger.error({ err, integrationId }, "slack channel preload after oauth failed");
        }
      })();
    }

    res.redirect(302, `${returnUrl}?oauth_success=1&kind=${kind}`);
  });

  return router;
}
