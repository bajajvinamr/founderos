import { describe, expect, it } from "vitest";
import { redactSensitive } from "../middleware/logger.js";

describe("redactSensitive — flat object", () => {
  it("redacts password", () => {
    expect(redactSensitive({ password: "hunter2" })).toEqual({ password: "[redacted]" });
  });

  it("redacts token", () => {
    expect(redactSensitive({ token: "sk-abc123" })).toEqual({ token: "[redacted]" });
  });

  it("redacts authorization", () => {
    expect(redactSensitive({ authorization: "Bearer xyz" })).toEqual({ authorization: "[redacted]" });
  });

  it("redacts api_key and apikey variants", () => {
    expect(redactSensitive({ api_key: "key1", apikey: "key2" })).toEqual({
      api_key: "[redacted]",
      apikey: "[redacted]",
    });
  });

  it("preserves non-sensitive fields", () => {
    expect(redactSensitive({ companyId: "abc", name: "test", count: 42 })).toEqual({
      companyId: "abc",
      name: "test",
      count: 42,
    });
  });

  it("is case-insensitive on key names", () => {
    expect(redactSensitive({ PASSWORD: "x", Token: "y", ACCESS_TOKEN: "z" })).toEqual({
      PASSWORD: "[redacted]",
      Token: "[redacted]",
      ACCESS_TOKEN: "[redacted]",
    });
  });
});

describe("redactSensitive — nested objects", () => {
  it("redacts secrets inside nested bodies", () => {
    const body = {
      user: { email: "a@b.com", password: "secret123" },
      meta: { source: "api" },
    };
    expect(redactSensitive(body)).toEqual({
      user: { email: "a@b.com", password: "[redacted]" },
      meta: { source: "api" },
    });
  });

  it("redacts inside arrays", () => {
    const body = { tokens: [{ token: "tok1" }, { token: "tok2" }] };
    expect(redactSensitive(body)).toEqual({
      tokens: [{ token: "[redacted]" }, { token: "[redacted]" }],
    });
  });

  it("stops at depth 6 to prevent unbounded recursion", () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 8; i++) {
      node.nested = {};
      node = node.nested as Record<string, unknown>;
    }
    node.password = "should-not-recurse-this-far";
    // Should not throw regardless of depth
    expect(() => redactSensitive(deep)).not.toThrow();
  });
});

describe("redactSensitive — edge cases", () => {
  it("returns primitives unchanged", () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive("hello")).toBe("hello");
    expect(redactSensitive(true)).toBe(true);
  });

  it("returns null unchanged", () => {
    expect(redactSensitive(null)).toBeNull();
  });

  it("handles empty object", () => {
    expect(redactSensitive({})).toEqual({});
  });

  it("handles undefined values in object without throwing", () => {
    expect(() => redactSensitive({ a: undefined })).not.toThrow();
  });
});
