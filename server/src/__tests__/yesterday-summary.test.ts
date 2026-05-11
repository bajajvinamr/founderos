/**
 * yesterday-summary.test.ts — unit tests for BL-022 / P8.b.
 *
 * Scope:
 *   1. Empty-completion short-circuit — zero rows → outcomes=[], source='empty',
 *      Haiku is NEVER called.
 *   2. LLM happy path — Haiku returns well-formed JSON, outcomes are mapped
 *      to source ids, capped to MAX_OUTCOMES.
 *   3. Fallback — Haiku throws → synthesizeFallbackOutcomes from raw titles.
 *   4. Fallback — Haiku returns malformed JSON → fallback.
 *   5. Fallback — Haiku invents ids not in source → fallback (no hallucinated
 *      outcomes leak through).
 *   6. Cache hit — second call with same date returns cached summary without
 *      re-querying DB or LLM.
 *   7. Cache bypass via `bypassCache: true` regenerates.
 *   8. No API key configured → fallback, NOT cached (so a fix surfaces on
 *      next call).
 *   9. Prompt structure assertion — buildYesterdayPrompt includes id markers.
 *
 * Uses a mock Db that returns canned issue rows; no embedded postgres needed
 * for this dispatch since the service is pure "rows → outcomes" once the
 * source data is in hand. The dashboard route layer is the integration
 * surface and would warrant a richer test (covered by existing dashboard
 * integration tests if/when added).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@founderos/db";
import {
  _resetYesterdaySummaryCache,
  buildYesterdayPrompt,
  extractOutcomesJson,
  generateYesterdaySummary,
  synthesizeFallbackOutcomes,
  type AnthropicJsonCaller,
} from "../services/yesterday-summary.js";

type FakeRow = {
  id: string;
  title: string;
  completedAt: Date | null;
};

function mockDb(rows: FakeRow[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "iss-1",
    title: "Shipped a faster signup flow",
    completedAt: new Date("2026-05-10T20:00:00Z"),
    ...overrides,
  };
}

const NOW = new Date("2026-05-11T08:00:00Z");

beforeEach(() => {
  _resetYesterdaySummaryCache();
});

describe("generateYesterdaySummary — empty-completion short-circuit", () => {
  it("returns outcomes=[] when no completions in window", async () => {
    const db = mockDb([]);
    const callAnthropic = vi.fn<AnthropicJsonCaller>();
    const getAnthropicKey = vi.fn(async () => "sk-test");

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey,
    });

    expect(summary.outcomes).toEqual([]);
    expect(summary.source).toBe("empty");
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  it("does not call Haiku for the empty case (cost guard)", async () => {
    const db = mockDb([]);
    const callAnthropic = vi.fn<AnthropicJsonCaller>();
    const getAnthropicKey = vi.fn(async () => "sk-test");

    await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey,
    });

    expect(getAnthropicKey).not.toHaveBeenCalled();
    expect(callAnthropic).not.toHaveBeenCalled();
  });
});

describe("generateYesterdaySummary — LLM happy path", () => {
  it("maps Haiku output to source ids and returns source='llm'", async () => {
    const rows = [
      makeRow({ id: "iss-A", title: "Internal: shipped retry-handler-2" }),
      makeRow({ id: "iss-B", title: "wired up posthog signal" }),
      makeRow({ id: "iss-C", title: "deploy cleanup" }),
    ];
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: [
        { id: "iss-A", title: "Made job retries reliable", description: "Fewer manual reruns." },
        { id: "iss-B", title: "Lit up the analytics signal", description: "" },
        { id: "iss-C", title: "Cleaner deploys", description: "Removes manual steps." },
      ],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);
    const getAnthropicKey = vi.fn(async () => "sk-test");

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey,
    });

    expect(summary.source).toBe("llm");
    expect(summary.outcomes).toHaveLength(3);
    expect(summary.outcomes[0]).toEqual({
      id: "iss-A",
      title: "Made job retries reliable",
      description: "Fewer manual reruns.",
    });
    expect(callAnthropic).toHaveBeenCalledTimes(1);
  });

  it("caps outcomes at MAX_OUTCOMES (5)", async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      makeRow({ id: `iss-${i}`, title: `Title ${i}` }),
    );
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: rows.map((r) => ({ id: r.id, title: `Polished — ${r.title}`, description: "" })),
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(summary.source).toBe("llm");
    expect(summary.outcomes.length).toBeLessThanOrEqual(5);
  });

  it("drops Haiku-invented ids not present in source", async () => {
    const rows = [makeRow({ id: "iss-real", title: "real work" })];
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: [
        { id: "iss-real", title: "Real win", description: "" },
        { id: "iss-hallucinated", title: "Hallucinated win", description: "" },
      ],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(summary.source).toBe("llm");
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]?.id).toBe("iss-real");
  });

  it("falls back when ALL Haiku ids are hallucinated (no real ids survive)", async () => {
    const rows = [makeRow({ id: "iss-real", title: "real work" })];
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: [
        { id: "iss-bogus-1", title: "Fake", description: "" },
        { id: "iss-bogus-2", title: "Also fake", description: "" },
      ],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(summary.source).toBe("fallback");
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]?.id).toBe("iss-real");
  });
});

describe("generateYesterdaySummary — fallback paths", () => {
  it("falls back when Haiku throws", async () => {
    const rows = [makeRow({ id: "iss-1", title: "Some work happened" })];
    const db = mockDb(rows);
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => {
      throw new Error("network down");
    });

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(summary.source).toBe("fallback");
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]?.id).toBe("iss-1");
    // Fallback uses raw title verbatim (truncated if too long)
    expect(summary.outcomes[0]?.title).toBe("Some work happened");
  });

  it("falls back when Haiku returns non-JSON", async () => {
    const rows = [makeRow({ id: "iss-1", title: "Some work" })];
    const db = mockDb(rows);
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => "not json at all");

    const summary = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    expect(summary.source).toBe("fallback");
    expect(summary.outcomes).toHaveLength(1);
  });

  it("falls back when no Anthropic key is configured, and does NOT cache", async () => {
    const rows = [makeRow({ id: "iss-1", title: "Some work" })];
    const db = mockDb(rows);
    const callAnthropic = vi.fn<AnthropicJsonCaller>();

    const summary1 = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => null,
    });

    expect(summary1.source).toBe("fallback");
    expect(callAnthropic).not.toHaveBeenCalled();

    // Second call should re-query, NOT serve from cache, because the
    // missing-key fallback is explicitly uncached.
    const callAnthropic2 = vi.fn<AnthropicJsonCaller>(async () =>
      JSON.stringify({
        outcomes: [{ id: "iss-1", title: "Polished win", description: "" }],
      }),
    );
    const summary2 = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic: callAnthropic2,
      getAnthropicKey: async () => "sk-now-set",
    });

    expect(summary2.source).toBe("llm");
    expect(callAnthropic2).toHaveBeenCalledTimes(1);
  });
});

describe("generateYesterdaySummary — cache behaviour", () => {
  it("returns cached summary on second call within the same day", async () => {
    const rows = [makeRow({ id: "iss-1" })];
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: [{ id: "iss-1", title: "Win", description: "" }],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);
    const getAnthropicKey = vi.fn(async () => "sk-test");

    const first = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey,
    });
    const second = await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey,
    });

    expect(first).toEqual(second);
    expect(callAnthropic).toHaveBeenCalledTimes(1);
    // getAnthropicKey is only called when we miss the cache.
    expect(getAnthropicKey).toHaveBeenCalledTimes(1);
  });

  it("regenerates when bypassCache=true", async () => {
    const rows = [makeRow({ id: "iss-1" })];
    const db = mockDb(rows);
    const haikuPayload = JSON.stringify({
      outcomes: [{ id: "iss-1", title: "Win", description: "" }],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);

    await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
      bypassCache: true,
    });

    expect(callAnthropic).toHaveBeenCalledTimes(2);
  });

  it("scopes cache per tenant", async () => {
    const db = mockDb([makeRow({ id: "iss-1" })]);
    const haikuPayload = JSON.stringify({
      outcomes: [{ id: "iss-1", title: "Win", description: "" }],
    });
    const callAnthropic = vi.fn<AnthropicJsonCaller>(async () => haikuPayload);

    await generateYesterdaySummary(db, "co-1", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });
    await generateYesterdaySummary(db, "co-2", {
      now: NOW,
      callAnthropic,
      getAnthropicKey: async () => "sk-test",
    });

    // Different tenants ⇒ each generates fresh.
    expect(callAnthropic).toHaveBeenCalledTimes(2);
  });
});

describe("buildYesterdayPrompt", () => {
  it("includes the id marker for each completion so Haiku can reference them", () => {
    const completions = [
      { id: "iss-A", title: "first thing", completedAt: NOW },
      { id: "iss-B", title: "second thing", completedAt: NOW },
    ];
    const prompt = buildYesterdayPrompt(completions);
    expect(prompt).toContain("[id=iss-A]");
    expect(prompt).toContain("[id=iss-B]");
    expect(prompt).toContain("first thing");
    expect(prompt).toContain("second thing");
  });

  it("specifies the founder-language contract in the user prompt", () => {
    const prompt = buildYesterdayPrompt([
      { id: "iss-A", title: "x", completedAt: NOW },
    ]);
    expect(prompt).toMatch(/founder-language/i);
  });
});

describe("extractOutcomesJson", () => {
  it("strips ```json fences", () => {
    const raw = '```json\n{"outcomes":[{"id":"a","title":"t","description":""}]}\n```';
    const parsed = extractOutcomesJson(raw);
    expect(parsed.outcomes).toHaveLength(1);
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractOutcomesJson("no json here")).toThrow();
  });

  it("throws when outcomes array is missing", () => {
    expect(() => extractOutcomesJson('{"other":"key"}')).toThrow(/outcomes/);
  });

  it("filters items without id or title", () => {
    const raw = JSON.stringify({
      outcomes: [
        { id: "ok", title: "ok" },
        { id: "", title: "missing-id" },
        { id: "x", title: "" },
      ],
    });
    const parsed = extractOutcomesJson(raw);
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0]?.id).toBe("ok");
  });
});

describe("synthesizeFallbackOutcomes", () => {
  it("uses raw titles verbatim (with truncation)", () => {
    const completions = [
      { id: "iss-1", title: "short", completedAt: NOW },
      { id: "iss-2", title: "x".repeat(120), completedAt: NOW },
    ];
    const out = synthesizeFallbackOutcomes(completions);
    expect(out[0]?.title).toBe("short");
    expect(out[1]?.title.length).toBeLessThanOrEqual(80);
    expect(out[1]?.title.endsWith("...")).toBe(true);
  });

  it("caps at MAX_OUTCOMES even when given more", () => {
    const completions = Array.from({ length: 12 }, (_, i) => ({
      id: `iss-${i}`,
      title: `t${i}`,
      completedAt: NOW,
    }));
    const out = synthesizeFallbackOutcomes(completions);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("emits empty descriptions (founder still sees titles, no hallucinated context)", () => {
    const out = synthesizeFallbackOutcomes([
      { id: "iss-1", title: "title", completedAt: NOW },
    ]);
    expect(out[0]?.description).toBe("");
  });
});
