import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export function assertBoard(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  const strictIsolation = process.env.FOUNDEROS_STRICT_COMPANY_ISOLATION === "true";
  if (req.actor.type === "board" && (strictIsolation || req.actor.source !== "local_implicit") && !req.actor.isInstanceAdmin) {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
}

/**
 * Council 2026-05-05/06 P1 BLOCK fix — strict company-membership check that
 * does NOT bypass for instance admins. Use this for write endpoints on
 * tenant-scoped resources where customer-facing side effects can be triggered
 * (autonomous workflow lifecycle changes, runs that may send emails / charge
 * cards / mutate CRM state).
 *
 * `assertCompanyAccess` (above) lets instance admins bypass the membership
 * check — that's intentional for ops/audit visibility. But "I can SEE every
 * tenant" is not the same as "I can ACT on every tenant". A least-privilege
 * read (regular assertCompanyAccess + GET) is fine for admin debugging; an
 * autonomous-write that triggers customer emails should require actual
 * membership.
 *
 * Agents are still scoped by their own companyId regardless of caller type.
 * `local_implicit` (single-user local-trusted mode) is allowed because that
 * deployment shape has no separate tenant identity to be a "non-member" of.
 */
export function assertStrictCompanyMembership(req: Request, companyId: string) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return;
  }
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit") {
      // Single-user local-trusted mode — no tenancy to enforce.
      return;
    }
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden(
        "User must be a member of this company to perform this action. " +
        "Instance-admin role does not grant cross-tenant write access on " +
        "autonomy-sensitive endpoints.",
      );
    }
  }
}

export function actorCanAccessCompany(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") return req.actor.companyId === companyId;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  return (req.actor.companyIds ?? []).includes(companyId);
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
