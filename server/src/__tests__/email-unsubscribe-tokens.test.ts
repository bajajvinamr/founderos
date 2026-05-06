/**
 * email-unsubscribe-tokens.test.ts — S4.8 prerequisite #196 layer 2.
 *
 * Unit tests for HMAC-based unsubscribe token generation + verification.
 *
 * Coverage:
 *   1. generate → verify round-trip preserves payload
 *   2. tampered payload (modified topic / email / company) returns null
 *   3. tampered HMAC suffix returns null
 *   4. truncated token (no dot, single segment, three segments) returns null
 *   5. foreign-secret token (signed with different secret) returns null
 *   6. missing EMAIL_UNSUBSCRIBE_SECRET throws on generate AND verify
 *   7. uppercase email rejected by validator (must be lowercase)
 *   8. non-positive ts rejected by validator
 *   9. buildUnsubscribeUrl strips trailing slash + uses /api/u/customer/:token path
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeTokenPayload,
} from "../services/email-unsubscribe-tokens.js";

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
const TEST_SECRET = "test-secret-do-not-use-in-prod-c4f6a8b2-9d3e-4f17-bc05";

const validPayload: UnsubscribeTokenPayload = {
  c: "11111111-1111-1111-1111-111111111111",
  e: "alice@example.com",
  t: "onboarding",
  ts: 1780200000000,
};

describe("email-unsubscribe-tokens", () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env[SECRET_ENV];
    process.env[SECRET_ENV] = TEST_SECRET;
  });

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env[SECRET_ENV];
    } else {
      process.env[SECRET_ENV] = prevSecret;
    }
  });

  describe("generate → verify round-trip", () => {
    it("preserves the payload exactly", () => {
      const token = generateUnsubscribeToken(validPayload);
      const verified = verifyUnsubscribeToken(token);
      expect(verified).toEqual(validPayload);
    });

    it("produces a token shaped like <b64>.<b64>", () => {
      const token = generateUnsubscribeToken(validPayload);
      const parts = token.split(".");
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it("generates the same token deterministically for the same payload", () => {
      const a = generateUnsubscribeToken(validPayload);
      const b = generateUnsubscribeToken(validPayload);
      expect(a).toBe(b);
    });
  });

  describe("tamper detection", () => {
    it("returns null when the payload segment is modified", () => {
      const token = generateUnsubscribeToken(validPayload);
      const [, hmac] = token.split(".");
      // Different payload → same HMAC means the verify step must reject.
      const tampered = `${Buffer.from(
        JSON.stringify({ ...validPayload, t: "churn_rescue" }),
        "utf-8",
      ).toString("base64url")}.${hmac}`;
      expect(verifyUnsubscribeToken(tampered)).toBeNull();
    });

    it("returns null when the HMAC segment is modified", () => {
      const token = generateUnsubscribeToken(validPayload);
      const [payloadB64, hmac] = token.split(".");
      // Flip one character in the HMAC.
      const flipped = hmac[0] === "A" ? "B" : "A";
      const tampered = `${payloadB64}.${flipped}${hmac.slice(1)}`;
      expect(verifyUnsubscribeToken(tampered)).toBeNull();
    });

    it("returns null when token has no dot separator", () => {
      expect(verifyUnsubscribeToken("notatoken")).toBeNull();
    });

    it("returns null when token has too many segments", () => {
      expect(verifyUnsubscribeToken("a.b.c")).toBeNull();
    });

    it("returns null when payload segment is empty", () => {
      const token = generateUnsubscribeToken(validPayload);
      const [, hmac] = token.split(".");
      expect(verifyUnsubscribeToken(`.${hmac}`)).toBeNull();
    });

    it("returns null when HMAC segment is empty", () => {
      const token = generateUnsubscribeToken(validPayload);
      const [payloadB64] = token.split(".");
      expect(verifyUnsubscribeToken(`${payloadB64}.`)).toBeNull();
    });
  });

  describe("foreign-secret rejection", () => {
    it("rejects a token signed with a different secret", () => {
      const token = generateUnsubscribeToken(validPayload);
      // Re-key — verification should fail.
      process.env[SECRET_ENV] = "completely-different-secret";
      expect(verifyUnsubscribeToken(token)).toBeNull();
    });
  });

  describe("missing secret", () => {
    it("throws on generate when EMAIL_UNSUBSCRIBE_SECRET is unset", () => {
      delete process.env[SECRET_ENV];
      expect(() => generateUnsubscribeToken(validPayload)).toThrow(
        /EMAIL_UNSUBSCRIBE_SECRET/,
      );
    });

    it("throws on verify when EMAIL_UNSUBSCRIBE_SECRET is unset", () => {
      const token = generateUnsubscribeToken(validPayload);
      delete process.env[SECRET_ENV];
      expect(() => verifyUnsubscribeToken(token)).toThrow(
        /EMAIL_UNSUBSCRIBE_SECRET/,
      );
    });
  });

  describe("payload validation", () => {
    it("rejects uppercase email at verify time", () => {
      const upperPayload: UnsubscribeTokenPayload = {
        ...validPayload,
        e: "Alice@Example.com",
      };
      const token = generateUnsubscribeToken(upperPayload);
      // HMAC verifies (we generated it), but isUnsubscribeTokenPayload rejects
      // because e !== e.toLowerCase().
      expect(verifyUnsubscribeToken(token)).toBeNull();
    });

    it("rejects non-positive ts", () => {
      const zeroTs: UnsubscribeTokenPayload = { ...validPayload, ts: 0 };
      const token = generateUnsubscribeToken(zeroTs);
      expect(verifyUnsubscribeToken(token)).toBeNull();
    });
  });

  describe("buildUnsubscribeUrl", () => {
    it("constructs URL at /api/u/customer/:token", () => {
      const url = buildUnsubscribeUrl(
        "https://founderos.fly.dev",
        validPayload,
      );
      expect(url).toMatch(
        /^https:\/\/founderos\.fly\.dev\/api\/u\/customer\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
    });

    it("strips trailing slash from baseUrl", () => {
      const url = buildUnsubscribeUrl(
        "https://founderos.fly.dev/",
        validPayload,
      );
      expect(url).not.toContain(".dev//");
      expect(url).toMatch(/founderos\.fly\.dev\/api\/u\/customer\//);
    });

    it("verify round-trip works on the URL-embedded token", () => {
      const url = buildUnsubscribeUrl(
        "https://founderos.fly.dev",
        validPayload,
      );
      const token = url.split("/api/u/customer/")[1];
      expect(verifyUnsubscribeToken(token)).toEqual(validPayload);
    });
  });
});
