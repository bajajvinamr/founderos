/**
 * Finance scenario modeling (S5.4) — natural-language "what-if" engine.
 *
 * The killer demo: founder types "what happens if I reduce free credits
 * by 70%?" and gets a structured answer composed by Claude after calling
 * the existing finance services as tools.
 *
 * Why tool-use vs a single prompt with all the data inlined: the data is
 * O(MB) per company once you include the full retention curve + every
 * subscription event + 60-month runway projections. Inlining all of it
 * blows the context window for nothing — Claude only needs the slice
 * that's relevant to the founder's question. Tool-use lets the model
 * decide what to fetch.
 *
 * Available tools:
 *   - get_cockpit_metrics — current MRR/ARR/churn/LTV/CAC/payback
 *   - run_pricing_simulation — elasticity-aware tier change projection
 *   - get_churn_forecast — exponential retention curve with R²
 *   - get_runway_forecast — 60-month cash projection with bands
 *   - run_cash_plan — stackable scenario (hires/price/churn/marketing)
 *
 * Loop: Claude returns either a `tool_use` block (we execute, append
 * `tool_result`, loop) or a final text block (we parse and return).
 * Capped at maxSteps iterations to bound cost.
 *
 * Auth: per-instance Anthropic key from `instanceApiKeysService`. If no
 * key is configured, returns a clear error — no fallback to a hardcoded
 * canned answer because scenario modeling is necessarily company-specific.
 */

import { z } from "zod";
import type { Db } from "@founderos/db";
import { instanceApiKeysService } from "../instance-api-keys.js";
import { logger } from "../../middleware/logger.js";
import { computeCockpitMetrics } from "../finance/cockpit.js";
import { runPricingSimulation } from "../finance/pricing-simulator.js";
import { computeChurnForecast } from "../finance/churn-forecast.js";
import { computeRunwayForecast } from "../finance/runway-forecast.js";
import { computeCashPlan } from "../finance/cash-planning.js";
import type { CashPlanInput } from "@founderos/shared";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 4096;

// ── Tool definitions exposed to Claude ─────────────────────────────────────

const TOOLS = [
  {
    name: "get_cockpit_metrics",
    description:
      "Current cockpit metrics: MRR, ARR, active subs, gross churn rate, LTV, CAC, payback months. No params. Always call this first to ground the answer in current state.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_churn_forecast",
    description:
      "Exponential retention curve fit (a·exp(-b·t)) with R² confidence and 6-month projection. No params.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_runway_forecast",
    description:
      "60-month runway projection with conservative/base/optimistic bands and projected cash-out date. No params.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_pricing_simulation",
    description:
      "Project MRR/churn impact of price changes per tier with elasticity (ε=-1.2). Use when the question is about price changes specifically.",
    input_schema: {
      type: "object",
      properties: {
        tierChanges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tierId: { type: "string", description: "tier amount in cents as string, or human label" },
              currentPriceCents: { type: "integer", minimum: 0 },
              newPriceCents: { type: "integer", minimum: 0 },
            },
            required: ["tierId", "currentPriceCents", "newPriceCents"],
          },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["tierChanges"],
    },
  },
  {
    name: "run_cash_plan",
    description:
      "6-month (configurable) cash flow projection with stackable scenario adjustments: hires, price change %, churn delta %, marketing spend. Use this for compound what-ifs.",
    input_schema: {
      type: "object",
      properties: {
        hires: {
          type: "array",
          items: {
            type: "object",
            properties: {
              salaryCents: { type: "integer", minimum: 0 },
              startMonthOffset: { type: "integer", minimum: 0 },
            },
            required: ["salaryCents", "startMonthOffset"],
          },
          maxItems: 20,
          default: [],
        },
        priceChangePct: { type: "number", minimum: -50, maximum: 200, default: 0 },
        churnDeltaPct: { type: "number", minimum: -50, maximum: 50, default: 0 },
        monthlyMarketingSpendCents: { type: "integer", minimum: 0, default: 0 },
        horizonMonths: { type: "integer", minimum: 1, maximum: 24, default: 6 },
      },
      required: [],
    },
  },
] as const;

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Finance agent for a solo founder using FounderOS. You have tools that read live data (cockpit metrics, churn forecast, runway, pricing simulator, cash plan).

Your job: answer scenario questions ("what happens if I do X?") with concrete numbers from the founder's actual business, not generic advice.

Process:
1. Call get_cockpit_metrics first to ground the answer in current state.
2. Call other tools as needed for the specific question.
3. Synthesize a final answer in this exact JSON shape (no markdown fences, no preamble):

{
  "headline": "<one-line answer with numbers, under 140 chars>",
  "narrative": "<2-4 sentence explanation, plain prose, no bullets>",
  "keyNumbers": [
    {"label": "<short label>", "value": "<formatted number with units>", "delta": "<+/- vs baseline, optional>"}
  ],
  "warnings": ["<each warning is a complete sentence>"],
  "toolsUsed": ["<tool_name>", ...]
}

Rules:
- NEVER claim certainty. The data has confidence bands; respect them.
- If a tool returns confidence "low" or "insufficient_data", say so in warnings.
- If runway/cash projection shows months-out, mention the range across bands, not the point estimate.
- Numbers in keyNumbers: use $ for cents (divide by 100), % for rates, "mo" for months.
- Forbidden words: amazing, crucial, robust, comprehensive, nuanced, multifaceted, pivotal, vibrant.
- If the question is unclear or out-of-scope (not finance), put a single warning explaining the gap and an empty keyNumbers.`;

// ── Output schema ──────────────────────────────────────────────────────────

const keyNumberSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(60),
  delta: z.string().max(60).optional(),
});

export const scenarioResponseSchema = z.object({
  headline: z.string().min(1).max(280),
  narrative: z.string().min(1).max(2000),
  keyNumbers: z.array(keyNumberSchema).max(10),
  warnings: z.array(z.string().min(1).max(400)).max(10),
  toolsUsed: z.array(z.string().min(1).max(80)).max(10),
});
export type ScenarioResponse = z.infer<typeof scenarioResponseSchema>;

// ── Anthropic message types (minimal subset) ───────────────────────────────

interface ContentBlockText {
  type: "text";
  text: string;
}
interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type ContentBlock = ContentBlockText | ContentBlockToolUse;

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<ContentBlock | ToolResultBlock>;
}

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | string;
  content: ContentBlock[];
}

// ── Default Claude caller ──────────────────────────────────────────────────

export type ClaudeCaller = (params: {
  apiKey: string;
  messages: AnthropicMessage[];
}) => Promise<AnthropicResponse>;

async function defaultCallClaude(params: {
  apiKey: string;
  messages: AnthropicMessage[];
}): Promise<AnthropicResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: params.messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as AnthropicResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool dispatch ──────────────────────────────────────────────────────────

async function dispatchTool(
  db: Db,
  companyId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: unknown; isError: boolean }> {
  try {
    if (name === "get_cockpit_metrics") {
      const metrics = await computeCockpitMetrics(db, companyId);
      return { result: metrics, isError: false };
    }
    if (name === "get_churn_forecast") {
      const forecast = await computeChurnForecast(db, companyId);
      return { result: forecast, isError: false };
    }
    if (name === "get_runway_forecast") {
      const forecast = await computeRunwayForecast(db, companyId);
      // Replace Infinity with sentinel so JSON.stringify doesn't drop it.
      const serialized = {
        ...forecast,
        bands: {
          conservative: serializeBand(forecast.bands.conservative),
          base: serializeBand(forecast.bands.base),
          optimistic: serializeBand(forecast.bands.optimistic),
        },
      };
      return { result: serialized, isError: false };
    }
    if (name === "run_pricing_simulation") {
      const tierChanges = (input.tierChanges as unknown) ?? [];
      const cockpit = await computeCockpitMetrics(db, companyId);
      const cac = cockpit.cac.cents ?? 0;
      const result = await runPricingSimulation(
        db,
        companyId,
        tierChanges as Array<{
          tierId: string;
          currentPriceCents: number;
          newPriceCents: number;
        }>,
        cac,
      );
      return { result, isError: false };
    }
    if (name === "run_cash_plan") {
      const planInput: CashPlanInput = {
        hires: (input.hires as CashPlanInput["hires"]) ?? [],
        priceChangePct: (input.priceChangePct as number) ?? 0,
        churnDeltaPct: (input.churnDeltaPct as number) ?? 0,
        monthlyMarketingSpendCents:
          (input.monthlyMarketingSpendCents as number) ?? 0,
        horizonMonths: (input.horizonMonths as number) ?? 6,
      };
      const plan = await computeCashPlan(db, companyId, planInput);
      return { result: plan, isError: false };
    }
    return { result: `unknown tool: ${name}`, isError: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err: msg }, "scenario tool dispatch failed");
    return { result: msg, isError: true };
  }
}

function serializeBand(band: {
  band: string;
  monthsRemaining: number;
  projectedCashOutDate: string | null;
  monthlyBalances: unknown[];
}) {
  return {
    band: band.band,
    monthsRemaining:
      band.monthsRemaining === Infinity ? "infinite" : band.monthsRemaining,
    projectedCashOutDate: band.projectedCashOutDate,
    monthlyBalances: band.monthlyBalances,
  };
}

// ── JSON extractor ─────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence?.[1]) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("no JSON object in final response");
  }
  return JSON.parse(s.slice(first, last + 1));
}

// ── Main entrypoint ────────────────────────────────────────────────────────

export interface FinanceScenarioDeps {
  callClaude?: ClaudeCaller;
  getAnthropicKey?: () => Promise<string | null>;
}

export interface FinanceScenarioRunResult {
  response: ScenarioResponse;
  steps: number;
  toolCalls: Array<{ name: string; isError: boolean }>;
}

export async function runFinanceScenario(
  db: Db,
  companyId: string,
  question: string,
  maxSteps: number = 6,
  deps: FinanceScenarioDeps = {},
): Promise<FinanceScenarioRunResult> {
  const apiKeys = instanceApiKeysService(db);
  const getKey =
    deps.getAnthropicKey ??
    (() => apiKeys.getDecryptedKey("anthropic", "api"));
  const call = deps.callClaude ?? defaultCallClaude;

  const apiKey = await getKey();
  if (!apiKey) {
    throw new Error("no_anthropic_key");
  }

  const messages: AnthropicMessage[] = [
    { role: "user", content: question.trim() },
  ];

  const toolCalls: Array<{ name: string; isError: boolean }> = [];

  for (let step = 1; step <= maxSteps; step++) {
    const reply = await call({ apiKey, messages });

    // Append assistant turn verbatim — content blocks must round-trip.
    messages.push({ role: "assistant", content: reply.content });

    if (reply.stop_reason === "tool_use") {
      const toolUseBlocks = reply.content.filter(
        (b): b is ContentBlockToolUse => b.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) {
        // Stop_reason said tool_use but no blocks; abort to avoid loop.
        throw new Error("tool_use stop_reason with no tool_use blocks");
      }

      const results: ToolResultBlock[] = [];
      for (const block of toolUseBlocks) {
        const dispatch = await dispatchTool(db, companyId, block.name, block.input);
        toolCalls.push({ name: block.name, isError: dispatch.isError });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(dispatch.result),
          ...(dispatch.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    // Final text response — extract JSON.
    const textBlocks = reply.content.filter(
      (b): b is ContentBlockText => b.type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("");
    const parsed = extractJson(text);
    const validated = scenarioResponseSchema.parse(parsed);
    return { response: validated, steps: step, toolCalls };
  }

  throw new Error(`scenario loop did not terminate within ${maxSteps} steps`);
}
