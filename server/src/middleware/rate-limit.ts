import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";
import { getRequestId } from "../lib/request-context.js";

/**
 * Supabase auth webhook limiter: 60 req/min per IP
 * Handles Supabase webhook retries on auth events (user.created, user.updated)
 */
export const authWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req: Request, res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many requests",
      message: "Please try again later",
    });
  },
  skip: (req: Request) => {
    // Don't rate limit health checks or non-webhook paths
    return false;
  },
});

/**
 * Instance invite creation limiter: 20/hr per authenticated user
 * Prevents spam of invite creation by instance admins
 */
export const inviteCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 invites per hour
  keyGenerator: (req: Request, res: Response) => {
    // Use userId if available, fallback to IP
    return req.actor?.userId || ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        userId: _req.actor?.userId,
        ip: _req.ip,
        path: _req.path,
      },
      `Invite creation rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many invites",
      message: "You've created too many invites. Please try again later.",
    });
  },
});

/**
 * Instance invite consumption limiter: 10/hr per IP
 * Applies to signup path to prevent brute-force invite acceptance (redundant but defense-in-depth)
 * Note: This is behind Supabase auth already, but belt-and-suspenders protection
 */
export const inviteConsumeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 invites per hour
  keyGenerator: (req: Request, res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Invite consumption rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many signup attempts",
      message: "Please try again later",
    });
  },
});

/**
 * Stripe billing webhook limiter: 60 req/min per IP
 * Handles Stripe webhook retries on billing events (charge.succeeded, subscription.updated, etc.)
 */
export const billingWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req: Request, res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many requests",
      message: "Please try again later",
    });
  },
});

/**
 * PostHog webhook limiter: 120 req/min per IP.
 *
 * Closes the CodeQL "Missing rate limiting" finding (S2.3 PostHog connector).
 * The webhook route does HMAC verification but a wrong-signature flood still
 * costs DB read + HMAC compute per request. Higher cap than Stripe (120 vs 60)
 * because PostHog batches events and a real webhook can fire multiple times
 * per minute on a busy workspace.
 */
export const posthogWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  keyGenerator: (req: Request, res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many requests",
      message: "Please try again later",
    });
  },
});

/**
 * Agent invocation limiter: 30/min per authenticated user
 *
 * Caps the rate at which an actor can trigger Claude/Anthropic-billed work
 * via /agents/:id/heartbeat/invoke and /agents/:id/wakeup. The limit is
 * per-user (not per-agent) so a single founder running multiple agents
 * shares one bucket — a runaway tight-loop in one agent can't drain
 * a different agent's budget.
 *
 * Why 30/min: a healthy interactive session might fire 5-10 invocations
 * per minute (founder iterates on prompts, observes output, retries).
 * 30 buys 3-6× headroom while still hard-stopping a tight retry loop
 * within seconds. Tune up or down per real telemetry — the council BLOCK
 * was about presence-of-limit, not the exact number.
 */
export const agentInvokeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 invocations per minute
  keyGenerator: (req: Request, res: Response) => {
    return req.actor?.userId || ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        userId: _req.actor?.userId,
        agentId: _req.params?.id,
        path: _req.path,
      },
      `Agent invocation rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many agent invocations",
      message: "Slow down — agent runs cost money. Try again in a minute.",
    });
  },
});

/**
 * Onboarding bootstrap limiter: 5/hr per IP
 *
 * Prevents mass account creation through the onboarding flow. A real
 * founder bootstraps once — repeated bootstraps from the same IP
 * indicate scripted abuse.
 */
export const onboardingBootstrapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req: Request, res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        ip: _req.ip,
        userId: _req.actor?.userId,
        path: _req.path,
      },
      `Onboarding bootstrap rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many onboarding attempts",
      message: "Please try again later.",
    });
  },
});

/**
 * Provider validate-key limiter: 10 requests / 5 minutes / IP (S7.A.6).
 *
 * The `/api/providers/validate-key` endpoint is unauthenticated — it's
 * called from the onboarding wizard before any account exists. This
 * limiter is the guard against drive-by enumeration of our endpoint as
 * a free Anthropic / OpenAI / Google key-checker.
 *
 * Keys on IP because there is no authenticated user during onboarding.
 * 10 attempts per 5 minutes maps to ~2 attempts/min — enough for a real
 * founder iterating on a typo, far below an enumeration script.
 *
 * Returns 429 with `error: "rate_limit_exceeded"` so the UI can
 * distinguish "we throttled you" from "the upstream provider 429'd"
 * (which surfaces as `provider_rate_limit` from the route handler).
 */
export const providerValidateKeyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 attempts per IP per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request, _res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    // S7.A.6 council 2026-05-08 P3: include requestId in the body so the
    // abuse-path response carries the same correlation id as every other
    // error path. Without this, support cannot grep `fly logs | grep <id>`
    // for an exhausted-limit complaint. getRequestId() returns the value
    // set by requestIdMiddleware (mounted before this handler can fire).
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: "Too many validation attempts. Please try again in a few minutes.",
      requestId: getRequestId(),
    });
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Provider validate-key rate limit exceeded: ${options.message}`,
    );
  },
});

/**
 * Issue-nonce limiter: 5 requests / 1 minute / IP (S7.A.6 council 2026-05-08).
 *
 * The nonce-issuance endpoint exists to defeat IP-rotation against the
 * validate-key endpoint. Per-IP rate-limiting on this endpoint is the
 * floor of the combined ceiling — an attacker rotating IPs still has to
 * pay this cost per nonce. 5/min is enough headroom for a real founder
 * making 2-3 validation attempts during onboarding (the wizard issues
 * a fresh nonce on each "Validate" click).
 *
 * Returns 429 with `error: "rate_limit_exceeded"` matching the
 * validate-key limiter's contract — UI distinguishes this from upstream
 * provider 429s (which surface as `provider_rate_limit`).
 */
export const issueNonceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5, // 5 nonces per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request, _res: Response) => {
    return ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: "Too many nonce requests. Please try again in a minute.",
      requestId: getRequestId(),
    });
    logger.warn(
      {
        ip: _req.ip,
        path: _req.path,
      },
      `Issue-nonce rate limit exceeded: ${options.message}`,
    );
  },
});

/**
 * BYO key validation limiter: 30/hr per authenticated user
 * Prevents spam of key validation attempts
 */
export const byoKeyValidateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 validations per hour
  keyGenerator: (req: Request, res: Response) => {
    // Use userId if available, fallback to IP
    return req.actor?.userId || ipKeyGenerator(req.ip || "unknown");
  },
  handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
    logger.warn(
      {
        userId: _req.actor?.userId,
        ip: _req.ip,
        path: _req.path,
      },
      `Key validation rate limit exceeded: ${options.message}`,
    );
    res.status(429).json({
      error: "Too many validation attempts",
      message: "Please try again later",
    });
  },
});

// ── CodeQL js/missing-rate-limiting cluster — added 2026-05-10 ──────────────
// Closes 18 open alerts. Policy by route category:
//   Auth routes (OAuth, CLI auth create/approve): 10/min/IP — aggressive
//   Unsubscribe / token-consume routes: 30/min/IP — aggressive
//   Webhook receivers: 100/min/IP — moderate (high legit volume)
//   Adapter npm-install/reinstall: 10/min/user-or-IP — moderate (slow ops)
//   Adapter delete: 20/min/user-or-IP — moderate
//   CLI auth poll (frequent long-poll): 60/min/IP — moderate
//   CLI auth cancel: 30/min/IP
//   Agent claude-login: 20/min/user-or-IP
//   Plugin UI static assets: 600/min/IP — permissive (static files, CDN-like)
//
// All limiters key on req.ip which resolves to the real client IP because
// app.ts sets `trust proxy = 1` (Fly.io single-hop edge, line 168).

function makeIpLimiter(opts: {
  label: string;
  windowMs: number;
  max: number;
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request, _res: Response) =>
      ipKeyGenerator(req.ip || "unknown"),
    handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
      logger.warn(
        { ip: _req.ip, path: _req.path },
        `Rate limit exceeded [${opts.label}]: ${options.message}`,
      );
      res.status(429).json({
        error: "Too many requests",
        message: "Please try again later",
        requestId: getRequestId(),
      });
    },
  });
}

function makeUserOrIpLimiter(opts: {
  label: string;
  windowMs: number;
  max: number;
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request, _res: Response) =>
      req.actor?.userId || ipKeyGenerator(req.ip || "unknown"),
    handler: (_req: Request, res: Response, _next: NextFunction, options: any) => {
      logger.warn(
        { ip: _req.ip, userId: _req.actor?.userId, path: _req.path },
        `Rate limit exceeded [${opts.label}]: ${options.message}`,
      );
      res.status(429).json({
        error: "Too many requests",
        message: "Please try again later",
        requestId: getRequestId(),
      });
    },
  });
}

/**
 * OAuth start/callback limiter: 10/min/IP (CodeQL js/missing-rate-limiting #59, #60)
 * Auth flows are high-value targets; aggressive cap prevents state-forging brute-force.
 */
export const oauthFlowLimiter = makeIpLimiter({
  label: "oauth-flow",
  windowMs: 60 * 1000,
  max: 10,
});

/**
 * Digest unsubscribe limiter: 30/min/IP (CodeQL #56, #57)
 * HMAC token already limits damage, but a flood still writes to DB. 30/min
 * is enough for any real mail client retry loop.
 */
export const digestUnsubscribeLimiter = makeIpLimiter({
  label: "digest-unsubscribe",
  windowMs: 60 * 1000,
  max: 30,
});

/**
 * Customer email unsubscribe limiter: 30/min/IP (CodeQL #141, #142)
 * Same policy as digest unsubscribe — HMAC-gated DB write, replays are cheap.
 */
export const customerUnsubscribeLimiter = makeIpLimiter({
  label: "customer-unsubscribe",
  windowMs: 60 * 1000,
  max: 30,
});

/**
 * Resend webhook receiver limiter: 100/min/IP (CodeQL #143)
 * Svix HMAC verification happens early. 100/min matches Resend's documented
 * retry behavior (burst of retries on delivery failure).
 */
export const resendWebhookLimiter = makeIpLimiter({
  label: "resend-webhook",
  windowMs: 60 * 1000,
  max: 100,
});

/**
 * CLI auth challenge create limiter: 10/min/IP (CodeQL #52)
 * Creates a pending challenge row + short-lived token. Aggressive cap prevents
 * challenge-table flooding from unauthenticated callers.
 */
export const cliAuthCreateLimiter = makeIpLimiter({
  label: "cli-auth-create",
  windowMs: 60 * 1000,
  max: 10,
});

/**
 * CLI auth challenge poll (GET) limiter: 60/min/IP (CodeQL #53)
 * Long-poll pattern — the CLI polls every ~1s waiting for approval.
 * 60/min = 1/s headroom, aligned to suggestedPollIntervalMs=1000ms.
 */
export const cliAuthPollLimiter = makeIpLimiter({
  label: "cli-auth-poll",
  windowMs: 60 * 1000,
  max: 60,
});

/**
 * CLI auth challenge approve limiter: 10/min/IP (CodeQL #54)
 * User-initiated approval is a one-shot action. 10/min is generous.
 */
export const cliAuthApproveLimiter = makeIpLimiter({
  label: "cli-auth-approve",
  windowMs: 60 * 1000,
  max: 10,
});

/**
 * CLI auth challenge cancel limiter: 30/min/IP (CodeQL #55)
 * Cancel is low-risk but still mutates the challenge row.
 */
export const cliAuthCancelLimiter = makeIpLimiter({
  label: "cli-auth-cancel",
  windowMs: 60 * 1000,
  max: 30,
});

/**
 * Agent claude-login limiter: 20/min/user-or-IP (CodeQL #58)
 * Triggers a child process (claude CLI login flow). Behind assertBoard.
 */
export const agentClaudeLoginLimiter = makeUserOrIpLimiter({
  label: "agent-claude-login",
  windowMs: 60 * 1000,
  max: 20,
});

/**
 * Adapter install/reinstall limiter: 10/min/user-or-IP (CodeQL #49, #51)
 * Shells out to npm. Behind assertBoard. Slow operation — 10/min is generous.
 */
export const adapterInstallLimiter = makeUserOrIpLimiter({
  label: "adapter-install",
  windowMs: 60 * 1000,
  max: 10,
});

/**
 * Adapter delete limiter: 20/min/user-or-IP (CodeQL #50)
 * Mutates the adapter registry. Behind assertBoard.
 */
export const adapterDeleteLimiter = makeUserOrIpLimiter({
  label: "adapter-delete",
  windowMs: 60 * 1000,
  max: 20,
});

/**
 * Plugin UI static asset limiter: 600/min/IP (CodeQL #61)
 * Serves pre-built JS/CSS files — CDN-like, high throughput needed.
 * Rate-limit exists to satisfy CodeQL and cap runaway crawlers.
 */
export const pluginUiStaticLimiter = makeIpLimiter({
  label: "plugin-ui-static",
  windowMs: 60 * 1000,
  max: 600,
});
