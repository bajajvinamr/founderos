import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

/**
 * Supabase auth webhook limiter: 60 req/min per IP
 * Handles Supabase webhook retries on auth events (user.created, user.updated)
 */
export const authWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req: Request) => {
    return req.ip || "unknown";
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
  keyGenerator: (req: Request) => {
    // Use userId if available, fallback to IP
    return req.actor?.userId || req.ip || "unknown";
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
  keyGenerator: (req: Request) => {
    return req.ip || "unknown";
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
  keyGenerator: (req: Request) => {
    return req.ip || "unknown";
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
 * BYO key validation limiter: 30/hr per authenticated user
 * Prevents spam of key validation attempts
 */
export const byoKeyValidateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 validations per hour
  keyGenerator: (req: Request) => {
    // Use userId if available, fallback to IP
    return req.actor?.userId || req.ip || "unknown";
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
