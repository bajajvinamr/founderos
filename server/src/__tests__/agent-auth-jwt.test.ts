import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentJwtSecretMissingError,
  createLocalAgentJwt,
  verifyLocalAgentJwt,
} from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "FOUNDEROS_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "FOUNDEROS_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "FOUNDEROS_AGENT_JWT_ISSUER";
  const audienceEnv = "FOUNDEROS_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "founderos",
      aud: "founderos-api",
    });
    expect(typeof claims?.jti).toBe("string");
    expect(claims!.jti!.length).toBeGreaterThan(0);
  });

  it("throws AgentJwtSecretMissingError when secret is missing", () => {
    // Type-system elimination: createLocalAgentJwt no longer returns
    // `string | null` — missing secret is a server misconfiguration
    // (NOT a runtime "this token is invalid" failure), so it throws.
    // Same for verifyLocalAgentJwt: missing config throws (caller treats
    // as 5xx), but a malformed token still returns null (caller treats
    // as 401).
    process.env[secretEnv] = "";
    expect(() =>
      createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1"),
    ).toThrow(AgentJwtSecretMissingError);
    expect(() => verifyLocalAgentJwt("abc.def.ghi")).toThrow(
      AgentJwtSecretMissingError,
    );
  });

  it("does NOT fall back to BETTER_AUTH_SECRET when FOUNDEROS_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // Without a dedicated agent JWT secret, JWT issuance throws — no
    // silent fallback to BETTER_AUTH_SECRET, no key confusion.
    expect(() =>
      createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1"),
    ).toThrow(AgentJwtSecretMissingError);
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "founderos";
    process.env[audienceEnv] = "founderos-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
