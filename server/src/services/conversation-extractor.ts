/**
 * Conversation insight extractor.
 *
 * Wave 17E — customer conversations are a founder's #1 asset. We take a
 * pasted transcript + light company context, ask Claude to surface 3-8
 * durable, non-obvious lessons, and return them as structured insights the
 * founder can promote into company_memory one row at a time.
 *
 * Design notes:
 *  - Uses the instance's stored Anthropic API key (BYO-key per-instance,
 *    encrypted at rest). Never accepts a raw key from the request.
 *  - Calls the Anthropic Messages API directly via fetch — same pattern as
 *    `anthropic-key-validator.ts`, avoids adding an SDK dependency.
 *  - Output is validated with Zod before hitting the DB so a malformed
 *    model response fails loudly instead of polluting memory.
 *  - The system prompt is the whole product here — see
 *    SYSTEM_PROMPT below. Target: specific, non-obvious lessons a founder
 *    will still want to read 3 months from now.
 */

import { z } from "zod";
import type { Db } from "@founderos/db";
import { instanceApiKeysService } from "./instance-api-keys.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const EXTRACTION_MODEL = "claude-sonnet-4-6";
const EXTRACTION_TIMEOUT_MS = 60_000;
const MAX_INSIGHTS = 8;
const MIN_INSIGHTS = 1;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const extractedInsightSchema = z.object({
  title: z.string().min(3).max(120),
  content: z.string().min(10).max(600),
  confidence: z.number().min(0).max(1),
  source_quote: z.string().min(1).max(600),
});

export type ExtractedInsightT = z.infer<typeof extractedInsightSchema>;

export const extractionResultSchema = z.object({
  insights: z.array(extractedInsightSchema).min(MIN_INSIGHTS).max(MAX_INSIGHTS),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export type CompanyContext = {
  companyName?: string;
  companyDescription?: string;
  industry?: string;
};

// ---------------------------------------------------------------------------
// Dependency injection — makes the service testable without the real DB.
// ---------------------------------------------------------------------------

export type AnthropicCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

export type ExtractorDeps = {
  /** Resolve the instance's stored Anthropic key; return null when missing. */
  getAnthropicKey: () => Promise<string | null>;
  /** Call Anthropic and return the raw assistant text. */
  callAnthropic?: AnthropicCaller;
};

// ---------------------------------------------------------------------------
// System prompt — the heart of the feature.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are the memory keeper for a founder. You are reading one customer conversation and extracting the durable, non-obvious lessons the founder will still want to read 3 months from now.

## What makes a good insight
- Specific and concrete. Name the segment, the behaviour, the exact language the customer used.
- Non-obvious. If a smart competitor would already know it, don't write it down.
- Actionable or falsifiable. It should sharpen a future decision (what to build, what to say, who to avoid).
- Durable. A signal about a market, a segment, a workflow, a belief — not a scheduling detail.

## What to reject
- Generic platitudes ("customer wants good product", "the market is big").
- Restating logistics ("they use Gmail", "the call was 30 minutes").
- Your own recommendations. You are extracting what the customer revealed, not advising the founder.
- Anything the transcript does not literally support.

## Few-shot examples

### Example 1 — education SaaS for Indian schools
GOOD:
{
  "title": "Tier-2 parents trust 'CBSE-aligned' labels, not evidence-based language",
  "content": "Parent A repeatedly asked whether the screener was 'CBSE-aligned' and ignored clinical-validity framing. In Tier-2 cities, board-compliance language is the trust lever — lead with that in the landing copy, not with research citations.",
  "confidence": 0.8,
  "source_quote": "Is this CBSE-approved? My daughter's school only uses CBSE stuff."
}
BAD (too generic):
{ "title": "Parents care about trust", "content": "The parent wanted to feel safe.", "confidence": 0.5, "source_quote": "..." }

### Example 2 — B2B sales call
GOOD:
{
  "title": "BBPS is the warmest channel because their compliance team already pre-approved us",
  "content": "The head of payments mentioned BBPS skipped their usual 6-week legal review because we were on the NPCI whitelist. Treat BBPS-listed partners as fast-track leads; other banks will be 3-6 months slower.",
  "confidence": 0.85,
  "source_quote": "You guys were on the NPCI list so legal waved you through — that almost never happens."
}
BAD (advice, not extraction):
{ "title": "Focus on BBPS", "content": "We should prioritize BBPS leads.", "confidence": 0.9, "source_quote": "..." }

### Example 3 — user research on an AI tool
GOOD:
{
  "title": "Solo operators bounce off 'agent' framing; 'teammate' retains",
  "content": "Three of five interviewees called 'agents' creepy or corporate and preferred 'teammate' or 'assistant'. Keep 'teammate' as the primary noun in onboarding and the landing hero.",
  "confidence": 0.7,
  "source_quote": "'Agent' sounds like something my boss would use. I want a teammate."
}

## Output format
Return ONLY a JSON object matching:
{
  "insights": [
    { "title": "5-10 words", "content": "1-2 specific sentences", "confidence": 0.0-1.0, "source_quote": "verbatim span from the transcript" }
  ]
}

Rules:
- 3 to 8 insights. Fewer is better than padding.
- Every source_quote must appear verbatim in the transcript (case-insensitive match OK).
- Confidence reflects evidence strength in the transcript, not your general knowledge.
- No markdown, no preamble, no trailing prose — JSON only.`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildUserPrompt(transcript: string, companyContext?: CompanyContext): string {
  const ctxLines: string[] = [];
  if (companyContext?.companyName) {
    ctxLines.push(`Company: ${companyContext.companyName}`);
  }
  if (companyContext?.industry) {
    ctxLines.push(`Industry: ${companyContext.industry}`);
  }
  if (companyContext?.companyDescription) {
    ctxLines.push(`What the company does: ${companyContext.companyDescription}`);
  }
  const ctx = ctxLines.length > 0 ? `## Company context\n${ctxLines.join("\n")}\n\n` : "";
  return `${ctx}## Conversation transcript\n${transcript.trim()}\n\nExtract the durable, non-obvious lessons as JSON per the system prompt.`;
}

// ---------------------------------------------------------------------------
// Default Anthropic caller
// ---------------------------------------------------------------------------

async function defaultCallAnthropic(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: 2048,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Anthropic request failed (${response.status}): ${bodyText.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");

    if (!text.trim()) {
      throw new Error("Anthropic returned empty content");
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Output parsing — the model is told "JSON only" but cheap defensive parsing
// survives the occasional ```json fence or preamble.
// ---------------------------------------------------------------------------

function parseModelOutput(raw: string): ExtractionResult {
  const cleaned = stripCodeFence(raw).trim();
  // Fallback: grab the first {...} block if the model added preamble.
  const jsonCandidate = cleaned.startsWith("{") ? cleaned : extractJsonObject(cleaned);
  if (!jsonCandidate) {
    throw new Error("Could not locate JSON object in model output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (err) {
    throw new Error(`Model output was not valid JSON: ${(err as Error).message}`);
  }

  return extractionResultSchema.parse(parsed);
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) return fenceMatch[1];
  return text;
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function conversationExtractor(deps: ExtractorDeps) {
  const callAnthropic = deps.callAnthropic ?? defaultCallAnthropic;

  /**
   * Extract durable insights from a transcript. Throws on:
   *  - missing Anthropic key
   *  - empty transcript
   *  - model/network failure
   *  - malformed model output
   */
  async function extractInsights(
    transcript: string,
    companyContext?: CompanyContext,
  ): Promise<ExtractionResult> {
    const trimmed = transcript.trim();
    if (trimmed.length === 0) {
      throw new Error("Transcript is empty");
    }

    const apiKey = await deps.getAnthropicKey();
    if (!apiKey) {
      throw new Error(
        "No Anthropic API key configured for this instance — add one in Instance → Providers",
      );
    }

    const userPrompt = buildUserPrompt(trimmed, companyContext);

    const raw = await callAnthropic({
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    });

    return parseModelOutput(raw);
  }

  return { extractInsights };
}

/**
 * Convenience factory — wires the real instance-api-keys service to the
 * extractor. Routes use this path in production.
 */
export function conversationExtractorFromDb(db: Db, overrides?: Partial<ExtractorDeps>) {
  const apiKeys = instanceApiKeysService(db);
  return conversationExtractor({
    getAnthropicKey: () => apiKeys.getDecryptedKey("anthropic", "api"),
    callAnthropic: overrides?.callAnthropic,
    ...overrides,
  });
}
