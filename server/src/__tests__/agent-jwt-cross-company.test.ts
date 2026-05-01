import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Trust-boundary invariant test (Tier 1):
// An agent JWT with company_id claim X is rejected end-to-end when the
// agent record in DB belongs to a different company Y. Today this is
// enforced at auth.ts:217 (`agentRecord.companyId !== claims.company_id`).
// Without this assertion, an agent A whose key was issued for company A
// could craft (or replay across an exfiltrated secret) a JWT claiming
// company B and pivot — exactly the cross-tenant impersonation that
// breaks the FounderOS trust contract. This test guards the full
// middleware path, not just the verifier in isolation.

const mockBoardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
  resolveBoardAccess: vi.fn().mockResolvedValue(null),
  touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
}));

const mockJwt = vi.hoisted(() => ({
  verifyLocalAgentJwt: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: vi.fn().mockReturnValue(mockBoardAuth),
}));

vi.mock("../agent-auth-jwt.js", () => mockJwt);

import { actorMiddleware } from "../middleware/auth.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb(result)),
  );
  return chain;
}

function makeDb(callResults: unknown[][]) {
  let callIndex = 0;
  return {
    select: vi.fn().mockImplementation(() => makeSelectChain(callResults[callIndex++] ?? [])),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), catch: vi.fn().mockResolvedValue(undefined) }),
  };
}

function makeReq(token: string): Request {
  return {
    header: vi.fn().mockImplementation((name: string) => {
      if (name.toLowerCase() === "authorization") return `Bearer ${token}`;
      return undefined;
    }),
    actor: undefined,
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const claimsForCompanyA = {
  sub: AGENT_ID,
  company_id: COMPANY_A,
  adapter_type: "claude_local",
  run_id: RUN_ID,
  iat: 1_900_000_000,
  exp: 1_900_900_000,
  iss: "founderos",
  aud: "founderos-api",
  jti: "jti-1",
};

describe("actorMiddleware — agent JWT cross-company impersonation guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
  });

  it("agent JWT claiming company A but DB shows agent in company B → req.actor stays type=none", async () => {
    mockJwt.verifyLocalAgentJwt.mockReturnValue(claimsForCompanyA);

    const db = makeDb([
      [], // agentApiKeys lookup — no matching API key (forces JWT path)
      [{ id: AGENT_ID, companyId: COMPANY_B, status: "active" }], // DB-resolved agent is in B
    ]);

    const middleware = actorMiddleware(db as never, { deploymentMode: "authenticated" });
    const req = makeReq("forged.jwt.token");
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor.type).toBe("none");
    expect(mockJwt.verifyLocalAgentJwt).toHaveBeenCalledOnce();
  });

  it("agent JWT claim and agent record in same company A → req.actor is agent scoped to A", async () => {
    mockJwt.verifyLocalAgentJwt.mockReturnValue(claimsForCompanyA);

    const db = makeDb([
      [],
      [{ id: AGENT_ID, companyId: COMPANY_A, status: "active" }],
    ]);

    const middleware = actorMiddleware(db as never, { deploymentMode: "authenticated" });
    const req = makeReq("valid.jwt.token");
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor).toMatchObject({
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_A,
      source: "agent_jwt",
      runId: RUN_ID,
    });
  });

  it("agent JWT decoding succeeds but DB lookup returns no row → req.actor stays type=none", async () => {
    mockJwt.verifyLocalAgentJwt.mockReturnValue(claimsForCompanyA);

    const db = makeDb([
      [],
      [], // agent record missing entirely
    ]);

    const middleware = actorMiddleware(db as never, { deploymentMode: "authenticated" });
    const req = makeReq("revoked.agent.jwt");
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(req.actor.type).toBe("none");
  });

  it("agent JWT belongs to terminated agent → req.actor stays type=none", async () => {
    mockJwt.verifyLocalAgentJwt.mockReturnValue(claimsForCompanyA);

    const db = makeDb([
      [],
      [{ id: AGENT_ID, companyId: COMPANY_A, status: "terminated" }],
    ]);

    const middleware = actorMiddleware(db as never, { deploymentMode: "authenticated" });
    const req = makeReq("terminated.agent.jwt");
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(req.actor.type).toBe("none");
  });

  it("agent JWT belongs to pending_approval agent → req.actor stays type=none (cannot act before approval)", async () => {
    mockJwt.verifyLocalAgentJwt.mockReturnValue(claimsForCompanyA);

    const db = makeDb([
      [],
      [{ id: AGENT_ID, companyId: COMPANY_A, status: "pending_approval" }],
    ]);

    const middleware = actorMiddleware(db as never, { deploymentMode: "authenticated" });
    const req = makeReq("pending.agent.jwt");
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(req.actor.type).toBe("none");
  });
});
