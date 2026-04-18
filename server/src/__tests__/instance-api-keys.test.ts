import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptWithMasterKey,
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";

// Set a deterministic master key for the test suite so encryption
// round-trips are reproducible. Must run before the helpers are called.
beforeEach(() => {
  process.env.FOUNDEROS_SECRETS_MASTER_KEY =
    "A".repeat(43) + "=";
});

describe("encryptWithMasterKey / decryptWithMasterKey", () => {
  it("round-trips a short string", () => {
    const encrypted = encryptWithMasterKey("hello world");
    expect(encrypted).not.toContain("hello");
    expect(decryptWithMasterKey(encrypted)).toBe("hello world");
  });

  it("round-trips an API-key-shaped string", () => {
    const key = "sk-ant-api03-" + "x".repeat(95);
    const encrypted = encryptWithMasterKey(key);
    expect(decryptWithMasterKey(encrypted)).toBe(key);
  });

  it("produces different ciphertext for the same plaintext (IV randomized)", () => {
    const a = encryptWithMasterKey("same");
    const b = encryptWithMasterKey("same");
    expect(a).not.toBe(b);
    expect(decryptWithMasterKey(a)).toBe("same");
    expect(decryptWithMasterKey(b)).toBe("same");
  });

  it("envelope JSON contains the expected scheme tag", () => {
    const encrypted = encryptWithMasterKey("tag-me");
    const parsed = JSON.parse(encrypted) as { scheme: string; iv: string; tag: string; ciphertext: string };
    expect(parsed.scheme).toBe("local_encrypted_v1");
    expect(parsed.iv.length).toBeGreaterThan(0);
    expect(parsed.tag.length).toBeGreaterThan(0);
    expect(parsed.ciphertext.length).toBeGreaterThan(0);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptWithMasterKey("don't touch");
    const parsed = JSON.parse(encrypted) as { ciphertext: string };
    // Flip a byte in the ciphertext → AEAD tag should reject
    const tampered = JSON.stringify({
      ...parsed,
      ciphertext: "A" + parsed.ciphertext.slice(1),
    });
    expect(() => decryptWithMasterKey(tampered)).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Hint extraction — used in the UI to show users a safe confirmation
// that their key was saved. We duplicate the logic here; the service file
// keeps the real implementation private.
// ──────────────────────────────────────────────────────────────────────
function extractHint(value: string): string {
  if (value.length < 8) return "****";
  return "…" + value.slice(-4);
}

describe("key hint extraction", () => {
  it("returns **** for very short strings", () => {
    expect(extractHint("")).toBe("****");
    expect(extractHint("abc")).toBe("****");
    expect(extractHint("abc1234")).toBe("****"); // length 7
  });

  it("returns last 4 chars prefixed with ellipsis for normal keys", () => {
    expect(extractHint("sk-ant-xyz1234")).toBe("…1234");
    expect(extractHint("sk-ant-api03-" + "a".repeat(99))).toMatch(/…a{4}/);
  });
});
