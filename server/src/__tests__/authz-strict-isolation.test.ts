import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertCompanyAccess } from "../routes/authz.js";

// Minimal mock Request shape — only the `actor` property is consumed by authz.
function makeReq(actor: Record<string, unknown>): Request {
  return { actor } as unknown as Request;
}

const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

const strictKey = "FOUNDEROS_STRICT_COMPANY_ISOLATION";
const originalValue = process.env[strictKey];

beforeEach(() => {
  delete process.env[strictKey];
});

afterEach(() => {
  if (originalValue === undefined) delete process.env[strictKey];
  else process.env[strictKey] = originalValue;
});

describe("assertCompanyAccess — type=none", () => {
  it("throws 401 when actor type is none", () => {
    const req = makeReq({ type: "none" });
    expect(() => assertCompanyAccess(req, COMPANY_A)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe("assertCompanyAccess — type=agent", () => {
  it("allows agent accessing its own company", () => {
    const req = makeReq({ type: "agent", companyId: COMPANY_A });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });

  it("throws 403 when agent tries to access a different company", () => {
    const req = makeReq({ type: "agent", companyId: COMPANY_A });
    expect(() => assertCompanyAccess(req, COMPANY_B)).toThrow(
      expect.objectContaining({ status: 403, message: "Agent key cannot access another company" }),
    );
  });
});

describe("assertCompanyAccess — type=board, local_implicit (default mode)", () => {
  it("local_implicit board can access any company when strict isolation is off", () => {
    const req = makeReq({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });

  it("local_implicit board can access a company it is NOT a member of (strict isolation off)", () => {
    const req = makeReq({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [COMPANY_B],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });
});

describe("assertCompanyAccess — type=board, FOUNDEROS_STRICT_COMPANY_ISOLATION=true", () => {
  beforeEach(() => {
    process.env[strictKey] = "true";
  });

  it("local_implicit board is BLOCKED from a company it is not a member of", () => {
    const req = makeReq({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [COMPANY_B],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).toThrow(
      expect.objectContaining({ status: 403, message: "User does not have access to this company" }),
    );
  });

  it("local_implicit board CAN access a company it is a member of", () => {
    const req = makeReq({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [COMPANY_A, COMPANY_B],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });

  it("instance admin bypasses company membership check even under strict isolation", () => {
    const req = makeReq({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });
});

describe("assertCompanyAccess — type=board, session source (strict isolation off)", () => {
  it("session board without membership is denied", () => {
    const req = makeReq({
      type: "board",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [COMPANY_B],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).toThrow(
      expect.objectContaining({ status: 403, message: "User does not have access to this company" }),
    );
  });

  it("session board with membership is allowed", () => {
    const req = makeReq({
      type: "board",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [COMPANY_A],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });

  it("instance admin via session bypasses membership check", () => {
    const req = makeReq({
      type: "board",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
  });
});
