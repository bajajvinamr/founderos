/**
 * Server-authoritative generator for the 3 first-week decisions offered at
 * the end of onboarding.
 *
 * Prior version (buildServerFirstDecisions) was a pure bottleneck→templates
 * lookup — every founder with the same primary bottleneck saw identical
 * cards. Cofounder reported this made the onboarding feel canned. Goal of
 * this module: call Claude with the founder's vision + bottlenecks + team
 * shape + company name, return 3 cards that are specifically about their
 * business. Falls back to the legacy hardcoded templates when no Anthropic
 * key is configured so the onboarding always produces something.
 */

import { z } from "zod";
import { instanceApiKeysService } from "./instance-api-keys.js";
import type { Db } from "@founderos/db";
import { logger } from "../middleware/logger.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 20_000;

export const decisionSlotSchema = z.enum(["cos", "growth", "content", "finance"]);
export type DecisionSlot = z.infer<typeof decisionSlotSchema>;

export const firstDecisionCardSchema = z.object({
  id: z.string().min(1).max(80),
  slot: decisionSlotSchema,
  title: z.string().min(4).max(140),
  rationale: z.string().min(4).max(400),
});
export type FirstDecisionCard = z.infer<typeof firstDecisionCardSchema>;

const decisionsListSchema = z.array(firstDecisionCardSchema).min(3).max(3);

export interface GenerateFirstDecisionsInput {
  vision: string;
  bottlenecks: string[];
  team: "solo" | "with_cofounder" | "with_team";
  companyName?: string;
}

const SYSTEM_PROMPT = `You are the Chief of Staff for a solo-ish founder in the first week of using FounderOS. You have just taken the onboarding interview: you know what they are building, their top bottlenecks, their team shape, and their company name. Propose exactly 3 concrete experiments the founder should approve TODAY to push progress this week.

Rules:
- Every decision must reference the specific business (product, market, stage, bottleneck) — not generic advice.
- Decisions must be different. Do not ship three framings of the same experiment.
- Each must be completable or at least started inside 7 days.
- Each must be assignable to exactly one of these department slots: "cos" (chief of staff), "growth", "content", "finance". Pick the slot that is the natural owner.
- Title: under 90 chars, imperative, concrete. Do NOT name the slot in the title.
- Rationale: 1-2 sentences, under 300 chars. Explain WHY this experiment now — specific to their vision + bottleneck. No throat-clearing. No "this will help you".
- id: short snake_case slug for the card; unique within the 3.
- Output: JSON array of exactly 3 objects {id, slot, title, rationale}. Nothing else.

Forbidden words in output: amazing, crucial, robust, comprehensive, nuanced, multifaceted, underscore, pivotal, landscape, interplay, vibrant, furthermore, moreover.`;

function buildUserPrompt(input: GenerateFirstDecisionsInput): string {
  const lines: string[] = [];
  if (input.companyName) lines.push(`Company: ${input.companyName}`);
  lines.push(`What they are building: ${input.vision.trim()}`);
  lines.push(`Primary bottleneck(s): ${input.bottlenecks.join(", ")}`);
  lines.push(
    `Team shape: ${
      input.team === "solo"
        ? "solo founder"
        : input.team === "with_cofounder"
          ? "with a cofounder"
          : "small team (>=3)"
    }`,
  );
  lines.push("");
  lines.push("Return the JSON array only.");
  return lines.join("\n");
}

function extractJsonArray(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

async function callClaude(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
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
        max_tokens: 1024,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (payload.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    if (!text.trim()) throw new Error("Anthropic returned empty content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hardcoded fallback — used when no Anthropic key is configured, or when
 * the LLM call fails. Mirrors the old buildServerFirstDecisions shape.
 */
export function fallbackFirstDecisions(bottlenecks: string[]): FirstDecisionCard[] {
  const primary = bottlenecks[0] ?? "";
  if (primary === "pmf") {
    return [
      { id: "pmf_interviews", slot: "growth", title: "Run a 5-customer interview sprint this week", rationale: "Five 30-min calls, one write-up. Separate 'would pay' from 'polite nods'." },
      { id: "pmf_landing", slot: "growth", title: "Launch a landing-page A/B test", rationale: "Two headlines, one offer. See which promise actually converts." },
      { id: "pmf_insights_post", slot: "content", title: "Publish an insight post from your interviews", rationale: "Turn raw interview patterns into a public artefact." },
    ];
  }
  if (primary === "growth") {
    return [
      { id: "growth_channel_test", slot: "growth", title: "Pick one channel, ship an experiment by Friday", rationale: "One channel, one offer, one week." },
      { id: "growth_cold_email", slot: "growth", title: "Draft a cold-email campaign to 50 ICP founders", rationale: "Hand-written, not templated." },
      { id: "growth_launch_post", slot: "content", title: "Write a launch post paired to the first experiment", rationale: "Every experiment ships with a story." },
    ];
  }
  if (primary === "fundraising") {
    return [
      { id: "fr_list", slot: "growth", title: "Build a 30-investor list tiered by fit", rationale: "Cold list today, warmed intros this week." },
      { id: "fr_update", slot: "cos", title: "Draft a 4-paragraph founder update", rationale: "Send it to your 5 warmest investors. Reply rate = signal." },
      { id: "fr_runway", slot: "finance", title: "Lock a 12-month cash plan", rationale: "Number of months left is the only question investors actually ask first." },
    ];
  }
  if (primary === "hiring") {
    return [
      { id: "hire_jd", slot: "cos", title: "Write the job description for your next hire", rationale: "One page. Outcomes, not responsibilities." },
      { id: "hire_pipeline", slot: "growth", title: "Seed a 20-candidate sourcing list", rationale: "Warm intros first, LinkedIn search second." },
      { id: "hire_budget", slot: "finance", title: "Set a salary band + equity range", rationale: "Decide the number before you interview, not after." },
    ];
  }
  return [
    { id: "default_interviews", slot: "growth", title: "Run a 5-customer interview sprint this week", rationale: "Signal first, everything else second." },
    { id: "default_narrative", slot: "content", title: "Draft a one-page narrative for what you're building", rationale: "Writes down the story in one voice." },
    { id: "default_runway", slot: "finance", title: "Produce the first runway snapshot", rationale: "Five numbers, updated weekly." },
  ];
}

export interface GenerateFirstDecisionsDeps {
  callAnthropic?: typeof callClaude;
  getAnthropicKey?: () => Promise<string | null>;
}

/**
 * Generate 3 first-week decision cards tailored to the founder.
 * Returns fallback templates if no key is available or the LLM call fails.
 */
export async function generateFirstDecisions(
  db: Db,
  input: GenerateFirstDecisionsInput,
  deps: GenerateFirstDecisionsDeps = {},
): Promise<{ decisions: FirstDecisionCard[]; source: "llm" | "fallback" }> {
  const apiKeys = instanceApiKeysService(db);
  const getKey = deps.getAnthropicKey ?? (() => apiKeys.getDecryptedKey("anthropic", "api"));
  const call = deps.callAnthropic ?? callClaude;

  let apiKey: string | null;
  try {
    apiKey = await getKey();
  } catch (err) {
    logger.warn({ err }, "onboarding-decisions: failed to read Anthropic key, falling back");
    return { decisions: fallbackFirstDecisions(input.bottlenecks), source: "fallback" };
  }
  if (!apiKey) {
    return { decisions: fallbackFirstDecisions(input.bottlenecks), source: "fallback" };
  }

  try {
    const raw = await call({
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
    });
    const jsonText = extractJsonArray(raw);
    const parsed: unknown = JSON.parse(jsonText);
    const decisions = decisionsListSchema.parse(parsed);
    return { decisions, source: "llm" };
  } catch (err) {
    logger.warn({ err }, "onboarding-decisions: LLM call failed, using fallback");
    return { decisions: fallbackFirstDecisions(input.bottlenecks), source: "fallback" };
  }
}
