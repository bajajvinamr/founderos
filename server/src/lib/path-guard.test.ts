import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertResolvedInside } from "./path-guard.js";

describe("assertResolvedInside", () => {
  const base = "/base";

  // ── Allowed cases ────────────────────────────────────────────────────────
  it("allows a direct child", () => {
    expect(assertResolvedInside(base, "child")).toBe(path.resolve(base, "child"));
  });

  it("allows a nested child", () => {
    expect(assertResolvedInside(base, "child/grandchild")).toBe(
      path.resolve(base, "child/grandchild"),
    );
  });

  it("allows '.' (collapses to base itself)", () => {
    expect(assertResolvedInside(base, ".")).toBe(path.resolve(base));
  });

  it("allows 'child/..' (collapses to base itself)", () => {
    expect(assertResolvedInside(base, "child/..")).toBe(path.resolve(base));
  });

  it("normalizes the base dir before comparing", () => {
    // Trailing slashes, redundant segments — both should still resolve under
    // the canonical base.
    expect(assertResolvedInside("/base/", "child")).toBe(path.resolve(base, "child"));
    expect(assertResolvedInside("/base/./", "child")).toBe(path.resolve(base, "child"));
  });

  // ── Rejected cases ───────────────────────────────────────────────────────
  it("rejects '../escape'", () => {
    expect(() => assertResolvedInside(base, "../escape")).toThrow(/path traversal blocked/);
  });

  it("rejects an absolute path outside the base", () => {
    expect(() => assertResolvedInside(base, "/abs/escape")).toThrow(/path traversal blocked/);
  });

  it("rejects 'child/../../escape' (deep traversal)", () => {
    expect(() => assertResolvedInside(base, "child/../../escape")).toThrow(
      /path traversal blocked/,
    );
  });

  it("rejects '../base-evil/foo' even though it shares the base prefix (path.sep anchor)", () => {
    // Without the path.sep anchor, `/base-evil/foo`.startsWith("/base") is true —
    // this case verifies the anchor is doing its job.
    expect(() => assertResolvedInside(base, "../base-evil/foo")).toThrow(
      /path traversal blocked/,
    );
  });

  it("rejects a sibling whose name is a strict prefix of the base", () => {
    // Direct sibling case: candidate resolves to `/base-evil` itself, which
    // shares the `/base` prefix but is NOT inside `/base`.
    expect(() => assertResolvedInside(base, "../base-evil")).toThrow(
      /path traversal blocked/,
    );
  });
});
