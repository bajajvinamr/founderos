/**
 * yesterday-summary.ts — "What we shipped yesterday" (BL-022 / P8.b).
 *
 * Surfaces 3-5 task completions from the last 24h, summarized into
 * founder-language one-liners by Claude Haiku. Powers the YesterdayWidget
 * on the dashboard (the third P8 widget after TopBlockers + QuickWins).
 *
 * Design choices:
 *   - **Source**: completed `issues` (status='done' with completedAt in the
 *     last 24h). The dashboard already surfaces issue completions as the
 *     primary "task completion" signal — no need to invent a new "result
 *     event" abstraction; the existing schema already models it.
 *   - **Caching**: in-memory Map keyed on (companyId, forDateIso). Same
 *     tenant + same day = cache hit, no LLM call. Bounded LRU-ish cap of
 *     1024 entries (well above plausible per-process tenant count) with
 *     insertion-order eviction via `keys().next().value`. We deliberately
 *     do NOT use the database — a new cache table would be a Tier-3
 *     migration outside this dispatch's boundary. Per-process memory is
 *     acceptable because (a) the brief is cheap to regenerate on cache
 *     miss after a restart, and (b) the daily cron-style staleness
 *     contract (regenerate once per day) is preserved across restarts
 *     because the "have we generated for today?" question is answered
 *     from the cache. Migrations + a `yesterday_summaries` table are
 *     follow-up work tracked in the BL-022 PR description.
 *   - **Founder-language**: the prompt asks Haiku for terse, jargon-free
 *     one-sentence summaries — same voice the rest of the P8 dashboard
 *     widgets use. No metric IDs, no UUIDs, no API or "issue" jargon.
 *   - **Empty-completion short-circuit**: zero completed issues in the
 *     window returns an empty array WITHOUT calling Haiku. The widget
 *     renders its own empty state ("No completions yet").
 *   - **LLM failure fallback**: if Haiku fails or returns malformed JSON,
 *     we fall back to the raw issue titles (truncated). Founder still
 *     sees their wins; the failure is logged but not surfaced as an
 *     insight (the brief is the canonical "LLM hiccup" surface and we
 *     don't want to double-up insight rows from a low-stakes widget).
 *
 * The caller (route handler) is responsible for authentication +
 * tenant scoping; this module is pure "companyId → outcomes[]".
 */

import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { issues } from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { instanceApiKeysService } from "./instance-api-keys.js";

// ── Anthropic configuration (Haiku, matches existing patterns) ─────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1024;

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

// We pull a generous window of recent completions and cap to MAX_OUTCOMES
// at projection time. 25 is well above the 3-5 we display, but small enough
// that the prompt stays inside the Haiku model's comfortable input range.
const COMPLETIONS_LOOKBACK_LIMIT = 25;
const MIN_OUTCOMES = 3;
const MAX_OUTCOMES = 5;

// In-memory cache. Bounded to prevent unbounded growth across long-running
// processes (vinamr-invariant: long-lived Maps must have a size cap).
const CACHE_MAX_ENTRIES = 1024;

// ── Public types ───────────────────────────────────────────────────────────

export interface YesterdayOutcome {
  /** Stable id derived from the source issue — drives React keys. */
  id: string;
  /** Founder-language one-liner ("Shipped a faster signup flow"). */
  title: string;
  /** Optional supporting context — usually a one-sentence "why this
   *  matters" beat. Empty string when Haiku gave only a title. */
  description: string;
}

export interface YesterdaySummary {
  /** Founder-language outcomes (3-5 items on the happy path, [] when no
   *  completions in the window). */
  outcomes: YesterdayOutcome[];
  /** Where this summary came from. Useful for debugging and for the
   *  fallback surface decision (whether to retry on next poll). */
  source: "llm" | "fallback" | "empty";
  /** ISO yyyy-mm-dd of the day this summary represents. */
  forDate: string;
  /** When the summary was generated (cache freshness hint). */
  generatedAt: string;
}

export type AnthropicJsonCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

export type GenerateYesterdaySummaryOptions = {
  /** Override `now` — primarily for tests. */
  now?: Date;
  /** DI for the Haiku caller. */
  callAnthropic?: AnthropicJsonCaller;
  /** DI for the API key getter. */
  getAnthropicKey?: () => Promise<string | null>;
  /** Force a cache miss (e.g. for a manual "refresh" surface). */
  bypassCache?: boolean;
};

// ── Cache ───────────────────────────────────────────────────────────────────

type CacheEntry = { summary: YesterdaySummary };
const cache = new Map<string, CacheEntry>();

function cacheKey(companyId: string, forDateIso: string): string {
  return `${companyId}:${forDateIso}`;
}

function cacheGet(companyId: string, forDateIso: string): YesterdaySummary | null {
  const entry = cache.get(cacheKey(companyId, forDateIso));
  return entry ? entry.summary : null;
}

function cacheSet(companyId: string, forDateIso: string, summary: YesterdaySummary): void {
  const key = cacheKey(companyId, forDateIso);
  cache.set(key, { summary });
  // Insertion-order eviction. The Map preserves insertion order so
  // `keys().next().value` is the oldest entry — O(1) eviction, no LRU
  // bookkeeping required. See vinamr-invariants: long-lived caches must
  // have a bounded size.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Test hook — clears the in-memory cache. Production code should never
 * call this; it exists so test files can isolate per-test cache state
 * without sharing entries across cases.
 */
export function _resetYesterdaySummaryCache(): void {
  cache.clear();
}

// ── Source data ─────────────────────────────────────────────────────────────

type Completion = { id: string; title: string; completedAt: Date };

async function loadCompletions(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<Completion[]> {
  const rows = await db
    .select({
      id: issues.id,
      title: issues.title,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, windowStart),
      ),
    )
    .orderBy(desc(issues.completedAt))
    .limit(COMPLETIONS_LOOKBACK_LIMIT);

  return rows
    .filter((r): r is Completion =>
      r.completedAt !== null && typeof r.title === "string" && r.title.length > 0,
    );
}

// ── Date helpers ────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  // en-CA produces yyyy-mm-dd by definition. Anchor to UTC so the cache key
  // is stable across server-instance timezone drift — same day boundary
  // across all replicas.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const YESTERDAY_SYSTEM_PROMPT = `You are a founder's chief-of-staff. Summarize completed work in plain, terse founder-language. No jargon, no metric IDs, no internal ticket terminology. Each outcome is one short sentence (under 80 chars) plus an optional one-sentence "why this matters". Voice: a sharp operator briefing a busy founder — not a marketing copywriter.`;

export function buildYesterdayPrompt(completions: Completion[]): string {
  const lines: string[] = [];
  lines.push("Completed task titles from the last 24h:");
  lines.push("");
  for (const c of completions) {
    lines.push(`- [id=${c.id}] ${c.title.slice(0, 280)}`);
  }
  lines.push("");
  lines.push(
    'Return JSON: { "outcomes": [{ "id": "<source id verbatim>", "title": "<founder-language one-liner>", "description": "<optional one-sentence why-this-matters>" }] }',
  );
  lines.push("");
  lines.push(
    `Caps: between ${MIN_OUTCOMES} and ${MAX_OUTCOMES} outcomes. If fewer than ${MIN_OUTCOMES} completions are provided, return ALL of them (do not invent extras). Keep titles under 80 characters. \`description\` may be empty string when there is nothing meaningful to add.`,
  );
  return lines.join("\n");
}

// ── Default Anthropic caller ────────────────────────────────────────────────

async function defaultCallAnthropic(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: MAX_TOKENS,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic Haiku request failed (${response.status}): ${bodyText.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");

    if (!text.trim()) {
      throw new Error("Anthropic Haiku returned empty content");
    }
    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── JSON extraction ─────────────────────────────────────────────────────────

interface ParsedOutcomes {
  outcomes: Array<{ id: string; title: string; description?: string }>;
}

export function extractOutcomesJson(raw: string): ParsedOutcomes {
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch?.[1]) s = fenceMatch[1].trim();

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("No JSON object found in Haiku response");
  }
  const parsed = JSON.parse(s.slice(first, last + 1)) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { outcomes?: unknown }).outcomes)
  ) {
    throw new Error("Haiku response missing `outcomes` array");
  }
  const outcomes = (parsed as { outcomes: unknown[] }).outcomes
    .filter((item): item is { id: unknown; title: unknown; description?: unknown } =>
      item !== null && typeof item === "object",
    )
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      description: typeof item.description === "string" ? item.description : "",
    }))
    .filter((o) => o.id.length > 0 && o.title.length > 0);

  if (outcomes.length === 0) {
    throw new Error("Haiku response contained no valid outcomes");
  }
  return { outcomes };
}

// ── Fallback synthesis ──────────────────────────────────────────────────────

/**
 * When Haiku is unavailable or the response is malformed, fall back to the
 * raw issue titles. Founder still sees their wins — they just don't get
 * the polished "why this matters" beat.
 */
export function synthesizeFallbackOutcomes(
  completions: Completion[],
): YesterdayOutcome[] {
  return completions.slice(0, MAX_OUTCOMES).map((c) => ({
    id: c.id,
    // Truncate aggressively — the source title might be a long internal
    // identifier-style string that doesn't read well as a "win".
    title: c.title.length > 80 ? `${c.title.slice(0, 77)}...` : c.title,
    description: "",
  }));
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Generate-or-reuse the yesterday summary for `companyId`.
 *
 * Returns a `YesterdaySummary` with `outcomes` capped to MAX_OUTCOMES.
 * Cache key: (companyId, forDate). Same-day re-calls within the same
 * process hit cache; cross-process or cross-day calls regenerate.
 *
 * Never throws — LLM failure falls back to raw titles; an empty window
 * returns `{ outcomes: [], source: 'empty' }`.
 */
export async function generateYesterdaySummary(
  db: Db,
  companyId: string,
  options: GenerateYesterdaySummaryOptions = {},
): Promise<YesterdaySummary> {
  const now = options.now ?? new Date();
  const forDateIso = isoDate(now);

  if (!options.bypassCache) {
    const cached = cacheGet(companyId, forDateIso);
    if (cached) return cached;
  }

  const windowStart = new Date(now.getTime() - ONE_DAY_MS);
  const completions = await loadCompletions(db, companyId, windowStart);

  // ── Empty-completion short-circuit ──
  if (completions.length === 0) {
    const summary: YesterdaySummary = {
      outcomes: [],
      source: "empty",
      forDate: forDateIso,
      generatedAt: now.toISOString(),
    };
    cacheSet(companyId, forDateIso, summary);
    return summary;
  }

  // ── Resolve API key ──
  const getAnthropicKey =
    options.getAnthropicKey ??
    (async () =>
      instanceApiKeysService(db).getDecryptedKey("anthropic", "api"));
  const apiKey = await getAnthropicKey();

  if (!apiKey) {
    // No key configured — synthesize from raw titles. We do NOT cache the
    // missing-key fallback because the founder might add a key any moment;
    // forcing a regeneration on next call surfaces the fixed state without
    // a server restart.
    return {
      outcomes: synthesizeFallbackOutcomes(completions),
      source: "fallback",
      forDate: forDateIso,
      generatedAt: now.toISOString(),
    };
  }

  // ── Haiku call ──
  const callAnthropic = options.callAnthropic ?? defaultCallAnthropic;
  const userPrompt = buildYesterdayPrompt(completions);

  let parsed: ParsedOutcomes;
  try {
    const raw = await callAnthropic({
      apiKey,
      systemPrompt: YESTERDAY_SYSTEM_PROMPT,
      userPrompt,
    });
    parsed = extractOutcomesJson(raw);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "yesterday-summary: Haiku path failed, using fallback",
    );
    // Cache the fallback for the rest of the day so we don't hammer
    // Haiku with retries on every refresh.
    const fallback: YesterdaySummary = {
      outcomes: synthesizeFallbackOutcomes(completions),
      source: "fallback",
      forDate: forDateIso,
      generatedAt: now.toISOString(),
    };
    cacheSet(companyId, forDateIso, fallback);
    return fallback;
  }

  // Map back to source ids — anything Haiku invented (or hallucinated an
  // id for) gets dropped. We trust Haiku to summarize, not to be the
  // identity authority.
  const sourceIds = new Set(completions.map((c) => c.id));
  const cleaned: YesterdayOutcome[] = parsed.outcomes
    .filter((o) => sourceIds.has(o.id))
    .slice(0, MAX_OUTCOMES)
    .map((o) => ({
      id: o.id,
      title: o.title.length > 80 ? `${o.title.slice(0, 77)}...` : o.title,
      description: typeof o.description === "string" ? o.description : "",
    }));

  if (cleaned.length === 0) {
    // Haiku returned valid JSON but no ids matched real completions —
    // treat as fallback.
    logger.warn(
      { companyId, completionsCount: completions.length },
      "yesterday-summary: Haiku output ids did not match source — using fallback",
    );
    const fallback: YesterdaySummary = {
      outcomes: synthesizeFallbackOutcomes(completions),
      source: "fallback",
      forDate: forDateIso,
      generatedAt: now.toISOString(),
    };
    cacheSet(companyId, forDateIso, fallback);
    return fallback;
  }

  const summary: YesterdaySummary = {
    outcomes: cleaned,
    source: "llm",
    forDate: forDateIso,
    generatedAt: now.toISOString(),
  };
  cacheSet(companyId, forDateIso, summary);
  return summary;
}

// ── Re-exports for tests ────────────────────────────────────────────────────

export { isoDate as _isoDate };
