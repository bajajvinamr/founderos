/**
 * Centralized tenant-isolation helpers.
 *
 * Route handlers that accept a `companyId` from untrusted input (params,
 * query, body) MUST call `requireCompanyAccess(req, companyId)` before
 * touching any data scoped to that company. Instance admins bypass this
 * check; board users are allowed only when the company is in their
 * `companyIds` set; agents are allowed only when the company is the one
 * they are scoped to.
 *
 * This is a thin facade over {@link assertCompanyAccess} in
 * `routes/authz.ts` — kept here so non-route code can share the same
 * guard without creating a circular import through the routes tree.
 */
import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

/**
 * Throws `403 Forbidden` when the current actor cannot access `companyId`.
 * Returns silently on success. Mutations and reads MUST both call this.
 */
export function requireCompanyAccess(req: Request, companyId: string): void {
  if (!companyId || typeof companyId !== "string") {
    throw forbidden("companyId is required");
  }
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  // Local-trusted dev mode is always a full admin.
  if (req.actor.source === "local_implicit") return;
  if (req.actor.isInstanceAdmin) return;
  if (req.actor.type === "board") {
    const allowed = req.actor.companyIds ?? [];
    if (allowed.includes(companyId)) return;
    throw forbidden("No access to this company");
  }
  if (req.actor.type === "agent") {
    if (req.actor.companyId === companyId) return;
    throw forbidden("Agent key cannot access another company");
  }
  throw forbidden("No access to this company");
}

/**
 * For routes that do not take a `companyId` but still require the caller to
 * be a known principal with at least one company membership (or be an agent,
 * or instance admin). Use for "list my stuff" endpoints that filter server-
 * side using `req.actor.companyIds`.
 */
export function requireAnyCompany(req: Request): void {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.source === "local_implicit") return;
  if (req.actor.isInstanceAdmin) return;
  if (req.actor.type === "agent" && req.actor.companyId) return;
  if (req.actor.type === "board" && (req.actor.companyIds ?? []).length > 0) return;
  throw forbidden("No company memberships");
}
