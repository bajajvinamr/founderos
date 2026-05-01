import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them.
// vi.mock() is hoisted automatically; vi.hoisted() ensures safe forward refs.
// ---------------------------------------------------------------------------

const mockBoardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
  resolveBoardAccess: vi.fn().mockResolvedValue(null),
  touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: vi.fn().mockReturnValue(mockBoardAuth),
}));

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn().mockReturnValue(null),
}));

import { actorMiddleware } from "../middleware/auth.js";

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

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
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    catch: vi.fn().mockResolvedValue(undefined),
  };
  return {
    select: vi.fn().mockImplementation(() => makeSelectChain(callResults[callIndex++] ?? [])),
    update: vi.fn().mockReturnValue(updateChain),
    _updateChain: updateChain,
  };
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    header: vi.fn().mockReturnValue(undefined),
    actor: undefined,
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

// ---------------------------------------------------------------------------
// Auth parity tests (Phase 4.3)
// ---------------------------------------------------------------------------

const USER_ID = "user-uuid-0001";
const COMPANY_ID = "comp-uuid-0001";

const SESSION_RESULT = { user: { id: USER_ID, email: "test@example.com" } };

describe("actorMiddleware — auth parity (cookie vs bearer-session-fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
  });

  it("cookie-path session resolves board actor correctly", async () => {
    const resolveSession = vi.fn().mockResolvedValue(SESSION_RESULT);
    const db = makeDb([
      [],                        // instanceUserRoles → non-admin
      [{ companyId: COMPANY_ID }], // companyMemberships
    ]);
    const middleware = actorMiddleware(db as any, {
      deploymentMode: "authenticated",
      resolveSession,
    });
    const req = makeReq();
    (req.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor).toMatchObject({
      type: "board",
      userId: USER_ID,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
      source: "session",
    });
  });

  it("local_trusted always resolves to local-board admin actor", async () => {
    const db = makeDb([]);
    const middleware = actorMiddleware(db as any, { deploymentMode: "local_trusted" });
    const req = makeReq();
    (req.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("no auth header and no session → actor type is none", async () => {
    const db = makeDb([]);
    const middleware = actorMiddleware(db as any, { deploymentMode: "authenticated" });
    const req = makeReq();
    (req.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor.type).toBe("none");
  });

  it("session resolves isInstanceAdmin=true when instanceUserRoles row exists", async () => {
    const resolveSession = vi.fn().mockResolvedValue(SESSION_RESULT);
    const db = makeDb([
      [{ id: "role-row-id" }],     // instanceUserRoles → admin
      [{ companyId: COMPANY_ID }],  // companyMemberships
    ]);
    const middleware = actorMiddleware(db as any, {
      deploymentMode: "authenticated",
      resolveSession,
    });
    const req = makeReq();
    (req.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const next = vi.fn();
    await middleware(req, makeRes(), next);

    expect(req.actor).toMatchObject({
      type: "board",
      userId: USER_ID,
      isInstanceAdmin: true,
      source: "session",
    });
  });
});

// ---------------------------------------------------------------------------
// lastUsedAt debounce tests (Phase 4.4)
// ---------------------------------------------------------------------------

const AGENT_KEY_ID = "key-uuid-0001";
const AGENT_ID = "agent-uuid-0001";
const AGENT_COMPANY_ID = "comp-uuid-0002";
const FAKE_TOKEN = "fake-agent-api-key-token-debounce-test";

describe("actorMiddleware — lastUsedAt debounce (Phase 4.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
  });

  it("db.update fires once for two rapid requests with the same key", async () => {
    const agentKeyRow = {
      id: AGENT_KEY_ID,
      agentId: AGENT_ID,
      companyId: AGENT_COMPANY_ID,
      revokedAt: null,
      keyHash: "will-be-hashed",
    };
    const agentRow = { id: AGENT_ID, companyId: AGENT_COMPANY_ID, status: "active" };

    const db = makeDb([
      [agentKeyRow], // first request: key lookup
      [agentRow],    // first request: agent lookup
      [agentKeyRow], // second request: key lookup
      [agentRow],    // second request: agent lookup
    ]);

    const middleware = actorMiddleware(db as any, { deploymentMode: "authenticated" });

    const makeReqWithBearer = () => {
      const req = makeReq();
      (req.header as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name.toLowerCase() === "authorization") return `Bearer ${FAKE_TOKEN}`;
        return undefined;
      });
      return req;
    };

    await middleware(makeReqWithBearer(), makeRes(), vi.fn());
    await middleware(makeReqWithBearer(), makeRes(), vi.fn());

    // Flush setImmediate queue
    await new Promise<void>((r) => setImmediate(r));

    // Only the first request should have scheduled a lastUsedAt write
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db._updateChain.set).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
  });
});
