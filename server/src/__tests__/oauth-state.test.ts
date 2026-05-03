import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signOAuthState, verifyOAuthState } from "../services/oauth/state-store.js";
import type { OAuthStatePayload } from "../services/oauth/state-store.js";

const TEST_SECRET = "test-secret-for-oauth-state-signing";

function makePayload(overrides?: Partial<OAuthStatePayload>): OAuthStatePayload {
  return {
    userId: "user-123",
    companyId: "company-123",
    kind: "slack",
    returnUrl: "/integrations",
    nonce: "abc123",
    issuedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("OAuth state token", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.BETTER_AUTH_SECRET;
    vi.restoreAllMocks();
  });

  it("sign + verify round-trip returns the original payload", () => {
    const payload = makePayload();
    const token = signOAuthState(payload);
    const result = verifyOAuthState(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.userId).toBe(payload.userId);
      expect(result.payload.companyId).toBe(payload.companyId);
      expect(result.payload.kind).toBe(payload.kind);
      expect(result.payload.returnUrl).toBe(payload.returnUrl);
      expect(result.payload.nonce).toBe(payload.nonce);
      expect(result.payload.issuedAt).toBe(payload.issuedAt);
    }
  });

  // Regression test for council 2026-05-03 R2 P2 (Gemini): OAuth state CSRF.
  // verifyOAuthState must reject tokens missing userId; the /callback
  // controller in routes/oauth.ts then enforces userId equality.
  it("[council-2026-05-03] payload without userId is malformed", () => {
    // Hand-craft a state without userId — older signed tokens (pre-fix)
    // never carried it, so this catches both the format check and protects
    // against any leaked legacy state.
    const legacyPayload = {
      companyId: "company-attack",
      kind: "slack",
      returnUrl: "/integrations",
      nonce: "abc",
      issuedAt: Math.floor(Date.now() / 1000),
    };
    const encoded = Buffer.from(JSON.stringify(legacyPayload)).toString("base64url");
    const sig = createHmac("sha256", TEST_SECRET).update(encoded).digest("base64url");
    const token = `${encoded}.${sig}`;
    // Same secret as the verifier — sig is valid, only userId is missing.
    const result = verifyOAuthState(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("wrong signature returns invalid_signature", () => {
    const payload = makePayload();
    const token = signOAuthState(payload);
    // Corrupt the signature portion
    const parts = token.split(".");
    const badToken = `${parts[0]}.invalidsignature`;

    const result = verifyOAuthState(badToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("tampered payload returns invalid_signature", () => {
    const payload = makePayload();
    const token = signOAuthState(payload);
    const parts = token.split(".");

    // Re-encode a modified payload with the original signature
    const tamperedPayload = { ...payload, companyId: "evil-company" };
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
    const badToken = `${tamperedEncoded}.${parts[1]}`;

    const result = verifyOAuthState(badToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("expired token returns expired", () => {
    // Issue token 601 seconds in the past
    const payload = makePayload({
      issuedAt: Math.floor(Date.now() / 1000) - 601,
    });
    const token = signOAuthState(payload);
    const result = verifyOAuthState(token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  it("malformed token (no dot separator) returns malformed", () => {
    const result = verifyOAuthState("notavalidtoken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("malformed token (invalid base64url payload) returns malformed", () => {
    // Valid structure but payload is not JSON
    const encoded = Buffer.from("not json!!").toString("base64url");
    // Use the correct secret to produce a real HMAC — passes signature check, fails JSON parse
    const realSig = createHmac("sha256", TEST_SECRET).update(encoded).digest("base64url");
    const token = `${encoded}.${realSig}`;

    const result = verifyOAuthState(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });
});
