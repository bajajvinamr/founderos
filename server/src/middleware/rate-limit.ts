import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

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
