/**
 * Sprint 5 · S5.4 — finance scenario modeling integration tests.
 *
 * Validates the Claude tool-use loop with a stubbed `callClaude`:
 *   - Single-tool path: cockpit → final answer
 *   - Multi-tool path: cockpit → cash-plan → final answer
 *   - Tool-error path: dispatch fails → tool_result is_error → recover
 *   - JSON shape enforcement: invalid JSON → throw
 *   - maxSteps cap: looping caller → throw
 *   - No API key → "no_anthropic_key" error (no fallback)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyFinancials,
  createDb,
  events,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runFinanceScenario, type ClaudeCaller } from "../services/agents/finance-scenario.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping finance-scenario tests: ${support.reason ?? "unsupported"}`,
  );
}

// ── Helpers to build minimal Anthropic responses ──────────────────────────

function finalText(json: object): Awaited<ReturnType<ClaudeCaller>> {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(json) }],
  };
}

function toolUse(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Awaited<ReturnType<ClaudeCaller>> {
  return {
    stop_reason: "tool_use",
    content: toolUses.map((t) => ({
      type: "tool_use" as const,
      id: t.id,
      name: t.name,
      input: t.input,
    })),
  };
}

const okScenario = {
  headline: "Reducing free credits by 70% extends runway by ~3 months.",
  narrative:
    "Current MRR is $5k with $20k monthly burn; the credit reduction shaves ~$3k/mo off variable costs.",
  keyNumbers: [
    { label: "Current MRR", value: "$5,000" },
    { label: "Runway impact", value: "+3 mo" },
  ],
  warnings: [],
  toolsUsed: ["get_cockpit_metrics", "run_cash_plan"],
};

const NO_KEY = () => Promise.resolve(null);

describeEmbeddedPostgres("finance scenario", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("finance-scenario");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.delete(events);
    await db.delete(companyFinancials);
    await db.delete(companies);
    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [c] = await db
      .insert(companies)
      .values({
        name: "Scenario Test Co",
        instanceId: "test-instance",
        issuePrefix: `SC${suffix}`,
      })
      .returning();
    companyId = c.id;

    // Seed finance settings so cash-plan tool returns a real shape.
    await db.insert(companyFinancials).values({
      companyId,
      cashBalanceCents: 50_000_000,
      monthlyBurnCents: 2_000_000,
    });
  });

  it("rejects when no Anthropic key is configured", async () => {
    const callClaude = vi.fn();
    await expect(
      runFinanceScenario(db, companyId, "what if I cut burn by 30%?", 6, {
        callClaude,
        getAnthropicKey: NO_KEY,
      }),
    ).rejects.toThrow("no_anthropic_key");
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("single-tool path: cockpit → final answer", async () => {
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockResolvedValueOnce(
        toolUse([{ id: "tu_1", name: "get_cockpit_metrics", input: {} }]),
      )
      .mockResolvedValueOnce(finalText(okScenario));

    const result = await runFinanceScenario(
      db,
      companyId,
      "what's the current state?",
      6,
      {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      },
    );

    expect(result.steps).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_cockpit_metrics");
    expect(result.toolCalls[0].isError).toBe(false);
    expect(result.response.headline).toContain("runway");
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("multi-tool path: cockpit → cash-plan → final answer", async () => {
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockResolvedValueOnce(
        toolUse([{ id: "tu_1", name: "get_cockpit_metrics", input: {} }]),
      )
      .mockResolvedValueOnce(
        toolUse([
          {
            id: "tu_2",
            name: "run_cash_plan",
            input: { priceChangePct: 20, horizonMonths: 6 },
          },
        ]),
      )
      .mockResolvedValueOnce(finalText(okScenario));

    const result = await runFinanceScenario(
      db,
      companyId,
      "what if I raise prices 20%?",
      6,
      {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      },
    );

    expect(result.steps).toBe(3);
    expect(result.toolCalls.map((t) => t.name)).toEqual([
      "get_cockpit_metrics",
      "run_cash_plan",
    ]);
    expect(result.toolCalls.every((t) => !t.isError)).toBe(true);
  });

  it("parallel tool calls in one turn are dispatched", async () => {
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockResolvedValueOnce(
        toolUse([
          { id: "tu_1", name: "get_cockpit_metrics", input: {} },
          { id: "tu_2", name: "get_churn_forecast", input: {} },
        ]),
      )
      .mockResolvedValueOnce(finalText(okScenario));

    const result = await runFinanceScenario(
      db,
      companyId,
      "summarize current state",
      6,
      {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      },
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(new Set(result.toolCalls.map((t) => t.name))).toEqual(
      new Set(["get_cockpit_metrics", "get_churn_forecast"]),
    );
  });

  it("tool error is reported as is_error and loop continues", async () => {
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockResolvedValueOnce(
        toolUse([
          {
            id: "tu_1",
            name: "run_pricing_simulation",
            // empty tierChanges → service throws
            input: { tierChanges: [] },
          },
        ]),
      )
      .mockResolvedValueOnce(finalText(okScenario));

    const result = await runFinanceScenario(
      db,
      companyId,
      "what if I change prices?",
      6,
      {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      },
    );

    // run_pricing_simulation with no events seeded → no_tiers_derived error
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].isError).toBe(true);
    expect(result.response.headline).toBeTruthy();
  });

  it("unknown tool name returns is_error", async () => {
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockResolvedValueOnce(
        toolUse([{ id: "tu_1", name: "nonexistent_tool", input: {} }]),
      )
      .mockResolvedValueOnce(finalText(okScenario));

    const result = await runFinanceScenario(
      db,
      companyId,
      "test",
      6,
      {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      },
    );

    expect(result.toolCalls[0].isError).toBe(true);
  });

  it("invalid JSON in final response throws", async () => {
    const callClaude: ClaudeCaller = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "no json here" }],
    });

    await expect(
      runFinanceScenario(db, companyId, "test", 6, {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      }),
    ).rejects.toThrow();
  });

  it("JSON missing required fields fails Zod validation", async () => {
    const callClaude: ClaudeCaller = vi.fn().mockResolvedValue(
      finalText({ headline: "ok" }), // missing narrative, keyNumbers, etc.
    );

    await expect(
      runFinanceScenario(db, companyId, "test", 6, {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      }),
    ).rejects.toThrow();
  });

  it("maxSteps cap throws when loop never terminates", async () => {
    const callClaude: ClaudeCaller = vi.fn().mockResolvedValue(
      toolUse([{ id: "tu_loop", name: "get_cockpit_metrics", input: {} }]),
    );

    await expect(
      runFinanceScenario(db, companyId, "test", 3, {
        callClaude,
        getAnthropicKey: () => Promise.resolve("test-key"),
      }),
    ).rejects.toThrow(/did not terminate/);
    expect(callClaude).toHaveBeenCalledTimes(3);
  });

  it("text wrapped in code fence is still parseable", async () => {
    const callClaude: ClaudeCaller = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "```json\n" + JSON.stringify(okScenario) + "\n```",
        },
      ],
    });

    const result = await runFinanceScenario(db, companyId, "test", 6, {
      callClaude,
      getAnthropicKey: () => Promise.resolve("test-key"),
    });
    expect(result.response.headline).toBe(okScenario.headline);
  });

  it("get_runway_forecast returns Infinity-safe band shape", async () => {
    // Seed events and high cash so MRR > burn → Infinity runway.
    for (let i = 0; i < 50; i++) {
      await db.insert(events).values({
        companyId,
        source: "stripe",
        entityType: "subscription",
        eventName: "subscription.created",
        dedupKey: `s_${i}`,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
        payload: {
          subscription_id: `sub_${i}`,
          customer_id: `cus_${i}`,
          amount: "100000",
        },
      });
    }
    // bump cash high
    await db.update(companyFinancials).set({ cashBalanceCents: 100_000_000_000, monthlyBurnCents: 1 });

    let capturedToolResult: string | null = null;
    const callClaude: ClaudeCaller = vi
      .fn()
      .mockImplementationOnce(async () =>
        toolUse([{ id: "tu_1", name: "get_runway_forecast", input: {} }]),
      )
      .mockImplementationOnce(async ({ messages }) => {
        // Find the user message containing tool_result
        const last = messages[messages.length - 1];
        if (Array.isArray(last.content)) {
          const tr = last.content.find(
            (b) => "type" in b && b.type === "tool_result",
          ) as { content: string } | undefined;
          if (tr) capturedToolResult = tr.content;
        }
        return finalText(okScenario);
      });

    await runFinanceScenario(db, companyId, "what's my runway?", 6, {
      callClaude,
      getAnthropicKey: () => Promise.resolve("test-key"),
    });

    expect(capturedToolResult).toBeTruthy();
    // monthsRemaining=Infinity must serialize as the "infinite" sentinel,
    // NOT as null (which is what JSON.stringify does to non-finite numbers).
    expect(capturedToolResult!).not.toMatch(/"monthsRemaining"\s*:\s*null/);
    expect(capturedToolResult!).toMatch(/"monthsRemaining"\s*:\s*"infinite"/);
  });
});
