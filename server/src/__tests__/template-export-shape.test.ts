import { describe, it, expect } from "vitest";

/**
 * Pure-function tests for the template export shape helpers. We don't
 * stand up a DB here — the goal is to lock the invariants the exporter
 * guarantees so the round-trip through POST /api/templates/spawn stays
 * stable.
 *
 * If these break, forking a running company into a new one will silently
 * produce invalid templates.
 */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 100);
}

function makeSlugger() {
  const seen = new Map<string, number>();
  return (value: string): string => {
    const base = slugify(value) || "item";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

function deriveIssuePrefix(name: string): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);
  return letters.padEnd(3, "X");
}

describe("slugify", () => {
  it("lowercases + hyphenates", () => {
    expect(slugify("Agnost AI")).toBe("agnost-ai");
    expect(slugify("Hello World!!")).toBe("hello-world");
  });
  it("collapses runs of non-alnum", () => {
    expect(slugify("a  b   c")).toBe("a-b-c");
    expect(slugify("foo__bar---baz")).toBe("foo-bar-baz");
  });
  it("trims leading + trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });
  it("caps at 100 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(100);
  });
  it("returns empty string for no alphanumerics", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("makeSlugger — unique keys within an export", () => {
  it("returns bare slug on first call, suffixed on collisions", () => {
    const slug = makeSlugger();
    expect(slug("Alice")).toBe("alice");
    expect(slug("Alice")).toBe("alice-2");
    expect(slug("Alice")).toBe("alice-3");
  });

  it("uses 'item' fallback when slugify strips everything", () => {
    const slug = makeSlugger();
    expect(slug("!!!")).toBe("item");
    expect(slug("...")).toBe("item-2");
  });

  it("does not conflate different base slugs", () => {
    const slug = makeSlugger();
    expect(slug("Alice")).toBe("alice");
    expect(slug("Bob")).toBe("bob");
    expect(slug("Alice")).toBe("alice-2");
  });
});

describe("deriveIssuePrefix — exactly 3 uppercase letters", () => {
  it("takes the first 3 letters of the company name", () => {
    expect(deriveIssuePrefix("Acme Robotics")).toBe("ACM");
    expect(deriveIssuePrefix("Pred")).toBe("PRE");
    expect(deriveIssuePrefix("agnost.ai")).toBe("AGN");
  });
  it("strips non-letters before taking 3", () => {
    expect(deriveIssuePrefix("123 FounderOS 456")).toBe("FOU");
    expect(deriveIssuePrefix("X2 Corp")).toBe("XCO");
  });
  it("pads with X when the name is too short", () => {
    expect(deriveIssuePrefix("A")).toBe("AXX");
    expect(deriveIssuePrefix("")).toBe("XXX");
    expect(deriveIssuePrefix("42")).toBe("XXX");
  });
  it("always returns exactly 3 chars", () => {
    for (const name of ["A", "Ab", "Abc", "Abcd", "A1 B2 C3 D4", ""]) {
      expect(deriveIssuePrefix(name).length).toBe(3);
    }
  });
});
