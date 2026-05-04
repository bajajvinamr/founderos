import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@founderos/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@founderos/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

// Debounce lastUsedAt writes: at most once per 5 minutes per key ID.
const lastUsedAtWritten = new Map<string, number>();
const LAST_USED_AT_DEBOUNCE_MS = 5 * 60 * 1000;

function shouldWriteLastUsedAt(keyId: string): boolean {
  const now = Date.now();
  const last = lastUsedAtWritten.get(keyId);
  if (last !== undefined && now - last < LAST_USED_AT_DEBOUNCE_MS) return false;
  lastUsedAtWritten.set(keyId, now);
  return true;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);

  async function fetchBoardActorRows(userId: string) {
    return Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);
  }

  // Runs the post-signup bootstrap inline when a newly-authenticated user has
  // no instance role yet. Idempotent — the hook checks for an existing admin.
  //
  // Returns the post-bootstrap snapshot (roleRow + memberships) so call sites
  // build req.actor from refreshed state. Pre-2026-05-03 council fix this only
  // returned roleRow, which caused req.actor.companyIds to be built from the
  // stale pre-bootstrap memberships array — first authed request after invite
  // consumption returned [] companies and 403'd company-gated routes until the
  // second request. Always returning the full snapshot eliminates the
  // call-site footgun.
  async function maybeBootstrapNewUser(
    userId: string,
    email: string | null | undefined,
    initial: {
      roleRow: { id: string } | null;
      memberships: Array<{ companyId: string }>;
    },
  ): Promise<{
    roleRow: { id: string } | null;
    memberships: Array<{ companyId: string }>;
  }> {
    if (initial.roleRow || !email) return initial;
    try {
      const { runPostSignupBootstrap } = await import("../auth/post-signup-hook.js");
      const bootstrap = await runPostSignupBootstrap(db, { userId, email });
      if (bootstrap.promotedToInstanceAdmin || bootstrap.consumedInvite) {
        const [roleRow, memberships] = await fetchBoardActorRows(userId);
        return { roleRow, memberships };
      }
    } catch (err) {
      logger.warn({ err, userId }, "Inline post-signup bootstrap failed (non-fatal)");
    }
    return initial;
  }

  /**
   * Called when a Bearer token failed to match any agent/API key. The token
   * may still be a provider session token (Supabase access token) — delegate
   * to the configured session resolver and, if it returns a user, populate
   * `req.actor` using the same path the cookie flow uses.
   *
   * Returns `true` when the fallback produced a session (caller should
   * `return` without calling next() again — we've already populated
   * `req.actor` and invoked next()).
   */
  async function trySessionFallbackAndNext(
    req: Parameters<RequestHandler>[0],
    next: Parameters<RequestHandler>[2],
    runIdHeader: string | undefined,
  ): Promise<boolean> {
    if (opts.deploymentMode !== "authenticated" || !opts.resolveSession) return false;
    let session: BetterAuthSessionResult | null = null;
    try {
      session = await opts.resolveSession(req);
    } catch (err) {
      logger.warn(
        { err, method: req.method, url: req.originalUrl },
        "Failed to resolve auth session from Bearer token",
      );
      return false;
    }
    if (!session?.user?.id) return false;

    const userId = session.user.id;
    const [roleRowRaw, membershipsRaw] = await fetchBoardActorRows(userId);
    const { roleRow, memberships } = await maybeBootstrapNewUser(userId, session.user.email, {
      roleRow: roleRowRaw,
      memberships: membershipsRaw,
    });
    req.actor = {
      type: "board",
      userId,
      companyIds: memberships.map((row) => row.companyId),
      isInstanceAdmin: Boolean(roleRow),
      runId: runIdHeader ?? undefined,
      source: "session",
    };
    next();
    return true;
  }

  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-founderos-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRowRaw, membershipsRaw] = await fetchBoardActorRows(userId);
          const { roleRow, memberships } = await maybeBootstrapNewUser(userId, session.user.email, {
            roleRow: roleRowRaw,
            memberships: membershipsRaw,
          });
          req.actor = {
            type: "board",
            userId,
            companyIds: memberships.map((row) => row.companyId),
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    // Session-bearing Bearer tokens (e.g. Supabase access tokens) are also
    // valid. The session resolver is the authority for "is this a logged-in
    // human?" — we try it as a final fallback after all agent/key lookups
    // miss below. We defer actually calling it until those have run so
    // existing short-circuits (board keys, agent keys, agent JWTs) keep
    // their priority.

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          companyIds: access.companyIds,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        // Final fallback: the token may be a session token (Supabase access
        // token, etc.). If the provider resolver recognizes it, this call
        // populates req.actor and calls next() itself.
        if (await trySessionFallbackAndNext(req, next, runIdHeader ?? undefined)) return;
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        source: "agent_jwt",
      };
      next();
      return;
    }

    // Debounced: write lastUsedAt at most once per 5 min per key to avoid
    // write amplification on high-frequency agent requests.
    if (shouldWriteLastUsedAt(key.id)) {
      setImmediate(() => {
        db.update(agentApiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(agentApiKeys.id, key.id))
          .catch((err: unknown) => logger.warn({ err, keyId: key.id }, "Failed to update lastUsedAt"));
      });
    }

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
