/**
 * Unit tests for authz helper functions that are not covered by
 * authz-strict-isolation.test.ts (which focuses on assertCompanyAccess).
 *
 * Covers: assertBoard, assertInstanceAdmin, actorCanAccessCompany, getActorInfo
 */
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  assertBoard,
  assertInstanceAdmin,
  actorCanAccessCompany,
  getActorInfo,
} from "../routes/authz.js";

function makeReq(actor: Record<string, unknown>): Request {
  return { actor } as unknown as Request;
}

const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// assertBoard
// ---------------------------------------------------------------------------

describe("assertBoard", () => {
  it("allows board actor through", () => {
    const req = makeReq({ type: "board", source: "session" });
    expect(() => assertBoard(req)).not.toThrow();
  });

  it("throws 401 for type=none", () => {
    const req = makeReq({ type: "none" });
    expect(() => assertBoard(req)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("throws 403 for type=agent", () => {
    const req = makeReq({ type: "agent", agentId: "agent-1", companyId: COMPANY_A });
    expect(() => assertBoard(req)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

// ---------------------------------------------------------------------------
// assertInstanceAdmin
// ---------------------------------------------------------------------------

describe("assertInstanceAdmin", () => {
  it("allows local_implicit board (always instance admin)", () => {
    const req = makeReq({ type: "board", source: "local_implicit" });
    expect(() => assertInstanceAdmin(req)).not.toThrow();
  });

  it("allows board with isInstanceAdmin=true", () => {
    const req = makeReq({ type: "board", source: "session", isInstanceAdmin: true });
    expect(() => assertInstanceAdmin(req)).not.toThrow();
  });

  it("throws 403 for board without instance-admin flag", () => {
    const req = makeReq({ type: "board", source: "session", isInstanceAdmin: false });
    expect(() => assertInstanceAdmin(req)).toThrow(
      expect.objectContaining({ status: 403, message: "Instance admin access required" }),
    );
  });

  it("throws 401 for type=none (delegates to assertBoard)", () => {
    const req = makeReq({ type: "none" });
    expect(() => assertInstanceAdmin(req)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("throws 403 for type=agent (delegates to assertBoard)", () => {
    const req = makeReq({ type: "agent", companyId: COMPANY_A });
    expect(() => assertInstanceAdmin(req)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

// ---------------------------------------------------------------------------
// actorCanAccessCompany
// ---------------------------------------------------------------------------

describe("actorCanAccessCompany", () => {
  it("returns false for type=none", () => {
    const req = makeReq({ type: "none" });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(false);
  });

  it("returns true for agent matching its own companyId", () => {
    const req = makeReq({ type: "agent", companyId: COMPANY_A });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(true);
  });

  it("returns false for agent with a different companyId", () => {
    const req = makeReq({ type: "agent", companyId: COMPANY_A });
    expect(actorCanAccessCompany(req, COMPANY_B)).toBe(false);
  });

  it("returns true for local_implicit board for any company", () => {
    const req = makeReq({ type: "board", source: "local_implicit" });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(true);
    expect(actorCanAccessCompany(req, COMPANY_B)).toBe(true);
  });

  it("returns true for board with isInstanceAdmin=true for any company", () => {
    const req = makeReq({ type: "board", source: "session", isInstanceAdmin: true });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(true);
  });

  it("returns true for board whose companyIds includes the target", () => {
    const req = makeReq({ type: "board", source: "session", companyIds: [COMPANY_A] });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(true);
  });

  it("returns false for board whose companyIds does not include the target", () => {
    const req = makeReq({ type: "board", source: "session", companyIds: [COMPANY_A] });
    expect(actorCanAccessCompany(req, COMPANY_B)).toBe(false);
  });

  it("returns false for board with no companyIds", () => {
    const req = makeReq({ type: "board", source: "session" });
    expect(actorCanAccessCompany(req, COMPANY_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getActorInfo
// ---------------------------------------------------------------------------

describe("getActorInfo", () => {
  it("throws 401 for type=none", () => {
    const req = makeReq({ type: "none" });
    expect(() => getActorInfo(req)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("returns agent info for type=agent", () => {
    const req = makeReq({ type: "agent", agentId: "agent-1", runId: "run-1" });
    const info = getActorInfo(req);
    expect(info.actorType).toBe("agent");
    expect(info.actorId).toBe("agent-1");
    expect(info.agentId).toBe("agent-1");
    expect(info.runId).toBe("run-1");
  });

  it("falls back to 'unknown-agent' when agentId is missing", () => {
    const req = makeReq({ type: "agent" });
    const info = getActorInfo(req);
    expect(info.actorId).toBe("unknown-agent");
    expect(info.agentId).toBeNull();
  });

  it("returns user info for type=board", () => {
    const req = makeReq({ type: "board", userId: "user-1", source: "session" });
    const info = getActorInfo(req);
    expect(info.actorType).toBe("user");
    expect(info.actorId).toBe("user-1");
    expect(info.agentId).toBeNull();
    expect(info.runId).toBeNull();
  });

  it("falls back to 'board' actorId when userId is missing", () => {
    const req = makeReq({ type: "board", source: "local_implicit" });
    const info = getActorInfo(req);
    expect(info.actorId).toBe("board");
  });
});
