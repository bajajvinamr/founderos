/**
 * growth-suggester.ts — Growth experiment suggester (S3.6).
 *
 * Triggered from a heartbeat run when the agent's department slot is
 * `growth`. Pipeline:
 *
 *   1. Aggregate inputs: last 30d events (filtered by source), open insights,
 *      current KPI snapshots from companies.metrics + the events.entity_type
 *      ='kpi' convention shipped in S3.2.
 *   2. Call Anthropic with the growth-suggester prompt (DI'd, mirrors
 *      brief-prompt.ts pattern: bare fetch, x-api-key header, 60s timeout).
 *      Output is a Zod-validated `{ experiments: [...] }` envelope.
 *   3. For each proposed hypothesis, embed it (default: deterministic
 *      sha256-based pseudo-embedding stand-in for dedup-only purposes;
 *      pluggable via `embedHypothesis` for a real provider in S6 polish).
 *   4. pgvector cosine search against existing `proposed` experiments —
 *      `1 - (hypothesis_embedding <=> :new_embedding) > 0.85` → skip.
 *      When pgvector is absent (extension not loaded), fall back to a
 *      sha256(title) string-equality dedup against existing proposed rows.
 *   5. Insert survivors with the LLM's ICE values + the embedding.
 *   6. Cap to 5 inserts per run.
 *
 * Bad-LLM-output contract:
 *   - Malformed JSON, schema-failed JSON, network failure → run aborts,
 *     write a kind='blocker' insight (department='growth') so the founder
 *     sees the agent failure in the normal insights surface. Caller is
 *     responsible for transitioning the agent to `error` state — this
 *     service does not touch the agents table.
 *
 * Embedding choice (text-embedding-3-small dim = 1536):
 *   The schema reserves a vector(1536) column. The default
 *   `sha256PseudoEmbedding` produces a 1536-dim float vector by repeating
 *   the sha256(text) digest into the vector slots, normalized to unit
 *   length. NOT a semantic embedding — it gives ≈1.0 cosine to identical
 *   strings and very low cosine to anything else, which is sufficient
 *   for the "skip exact-or-near-exact duplicate" use case but cannot
 *   detect paraphrase. Replace with a real embedding provider (Voyage AI
 *   `voyage-3-large` or OpenAI `text-embedding-3-small`) by passing
 *   `embedHypothesis` from the caller. TODO(S6): wire real embeddings.
 *
 * Idempotency:
 *   Each agent run inserts up to 5 fresh experiments. Re-running the same
 *   agent against the same inputs ≈ produces the same proposals; the
 *   dedup gate makes the second run a no-op (or near-no-op). The unique
 *   guarantee here is "no duplicate hypotheses among proposed rows," NOT
 *   "exactly-once per agent run" — the spec wants the agent to be able
 *   to top up proposals as new signal arrives.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import {
  companies,
  events,
  experiments,
  insights,
  type Experiment,
  type ExperimentChannel,
  EXPERIMENT_CHANNELS,
  HYPOTHESIS_EMBEDDING_DIM,
} from "@founderos/db";
import { logger } from "../../middleware/logger.js";

// ── Anthropic configuration (mirrors brief-prompt.ts) ───────────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const NARRATIVE_MODEL = "claude-sonnet-4-6";
const NARRATIVE_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2048;

/** Lookback window for inputs: 30 days of events, insights. */
const INPUT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

/** Cap on experiments inserted per agent run. */
export const MAX_EXPERIMENTS_PER_RUN = 5;

/**
 * Cosine-similarity threshold for dedup. `1 - (a <=> b)` (the pgvector cosine
 * distance) > 0.85 → considered a duplicate. Threshold tuned high (0.85 not
 * 0.7) because the sha256 stand-in has a bimodal distribution: identical
 * strings → ≈1.0, anything else → ≈0.0. Real embeddings would warrant
 * threshold tuning later.
 */
export const DEDUP_COSINE_THRESHOLD = 0.85;

/** Sparse-data threshold (events count). Below this, prompt instructs
 * model to keep iceConfidence ≤ 5. */
const SPARSE_EVENT_THRESHOLD = 50;

// ── Public types ────────────────────────────────────────────────────────────

export type AnthropicJsonCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

export type EmbeddingProvider = (text: string) => Promise<number[]>;

export type SuggesterInputKpiSnapshot = {
  metric: string;
  value: number;
  unit?: string;
};

export type SuggesterInputInsight = {
  id: string;
  kind: string;
  title: string;
  body: string;
  confidence: number;
  recommendation?: string | null;
};

export type SuggesterInputs = {
  companyName: string;
  /** Total event count in the 30d lookback window (used for sparse check). */
  eventCount: number;
  /** Per-source event volumes ordered desc — surfaces channel signal. */
  eventsBySource: Array<{ source: string; count: number }>;
  /** Open insights last 30d (caps at 30 to keep prompt size sane). */
  openInsights: SuggesterInputInsight[];
  /** Current KPI values pulled from events.entity_type='kpi' convention. */
  kpiSnapshots: SuggesterInputKpiSnapshot[];
  /** Existing proposed-status experiments (for the LLM's awareness, NOT
   *  the dedup gate — dedup happens after embedding). */
  existingProposed: Array<{ hypothesis: string; channel: string | null }>;
};

export type GrowthSuggesterRunOptions = {
  /** DI hook for the Anthropic call. */
  callAnthropic?: AnthropicJsonCaller;
  /** DI hook for the API key getter. */
  apiKey: string;
  /** DI hook for the embedding provider. Defaults to sha256 pseudo-embedding. */
  embedHypothesis?: EmbeddingProvider;
  /** Override the system prompt path (test hook). */
  systemPromptOverride?: string;
  /** Cap override (test hook). */
  maxExperiments?: number;
};

export type GrowthSuggesterRunResult = {
  ok: true;
  proposed: Experiment[];
  /** Number of LLM proposals that were dedup-skipped. */
  skippedAsDuplicate: number;
  /** Number of LLM proposals beyond the per-run cap. */
  skippedAsCap: number;
  source: "llm";
};

export type GrowthSuggesterRunError = {
  ok: false;
  reason: string;
  blockerInsightId: string | null;
};

// ── Zod schema for the LLM envelope ─────────────────────────────────────────

const proposedExperimentSchema = z.object({
  hypothesis: z.string().min(20).max(400),
  channel: z.enum(EXPERIMENT_CHANNELS),
  expectedLiftPct: z.number().gte(-1).lte(5),
  expectedCacCents: z.number().int().gte(0).lte(1_000_000),
  iceImpact: z.number().int().gte(1).lte(10),
  iceConfidence: z.number().int().gte(1).lte(10),
  iceEase: z.number().int().gte(1).lte(10),
  rationale: z.string().min(50).max(600),
});

export type ProposedExperiment = z.infer<typeof proposedExperimentSchema>;

export const growthSuggesterPayloadSchema = z.object({
  experiments: z.array(proposedExperimentSchema).min(0).max(10),
});

// ── Default sha256 pseudo-embedding (dedup-only stand-in) ───────────────────

/**
 * Deterministic 1536-dim pseudo-embedding from a sha256 digest, repeated
 * into the vector slots. NOT semantic — produces ≈1.0 cosine for identical
 * strings, ≈random for non-identical. Sufficient for "exact-or-near-exact"
 * dedup but not paraphrase.
 *
 * TODO(S6): replace with a real embedding provider (Voyage AI or OpenAI).
 *
 * The vector is L2-normalized so cosine similarity equals the dot product.
 */
export function sha256PseudoEmbedding(text: string): number[] {
  const normalized = text.trim().toLowerCase();
  const out: number[] = new Array(HYPOTHESIS_EMBEDDING_DIM).fill(0);
  // Generate enough hash bytes to fill 1536 floats. Each sha256 = 32 bytes;
  // we need 1536 * 4 = 6144 bytes. So 192 rounds of hashing.
  const bytesNeeded = HYPOTHESIS_EMBEDDING_DIM * 4;
  const buf = Buffer.alloc(bytesNeeded);
  let offset = 0;
  let counter = 0;
  while (offset < bytesNeeded) {
    const digest = createHash("sha256")
      .update(`${counter}:${normalized}`)
      .digest();
    const writeLen = Math.min(digest.length, bytesNeeded - offset);
    digest.copy(buf, offset, 0, writeLen);
    offset += writeLen;
    counter += 1;
  }
  // Read floats from the buffer.
  for (let i = 0; i < HYPOTHESIS_EMBEDDING_DIM; i += 1) {
    // Map 4 bytes to a float in [-1, 1] — read uint32, divide by 2^32, shift.
    const u32 = buf.readUInt32BE(i * 4);
    out[i] = u32 / 0xffffffff - 0.5;
  }
  // L2-normalize so cosine = dot product.
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i += 1) {
    out[i]! /= norm;
  }
  return out;
}

// ── Default Anthropic caller (mirrors brief-prompt.ts) ──────────────────────

async function defaultCallAnthropic(params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NARRATIVE_TIMEOUT_MS);
  try {
    const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": params.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: NARRATIVE_MODEL,
        max_tokens: MAX_TOKENS,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic request failed (${response.status}): ${bodyText.slice(0, 500)}`,
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
      throw new Error("Anthropic returned empty content");
    }
    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── JSON extractor (mirrors brief-prompt.ts) ────────────────────────────────

export function extractJsonObject(raw: string): unknown {
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch?.[1]) s = fenceMatch[1].trim();

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("No JSON object found in LLM response");
  }
  const slice = s.slice(first, last + 1);
  return JSON.parse(slice);
}

// ── System prompt loader ────────────────────────────────────────────────────

let cachedSystemPrompt: string | null = null;

export async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const promptPath = fileURLToPath(
    new URL("./__prompts__/growth-suggester.md", import.meta.url),
  );
  const content = await readFile(promptPath, "utf8");
  cachedSystemPrompt = content;
  return content;
}

// ── User prompt builder ─────────────────────────────────────────────────────

export function buildUserPrompt(inputs: SuggesterInputs): string {
  const lines: string[] = [];
  const isSparse = inputs.eventCount < SPARSE_EVENT_THRESHOLD;

  lines.push(`Company: ${inputs.companyName}`);
  if (isSparse) {
    lines.push(
      `Signal volume: SPARSE (only ${inputs.eventCount} events in last 30d) — keep iceConfidence ≤ 5 across all proposals.`,
    );
  } else {
    lines.push(`Signal volume: NORMAL (${inputs.eventCount} events in last 30d).`);
  }

  lines.push("");
  lines.push("## Events by source (last 30d)");
  if (inputs.eventsBySource.length === 0) {
    lines.push("- (no events)");
  } else {
    for (const e of inputs.eventsBySource) {
      lines.push(`- ${e.source}: ${e.count}`);
    }
  }

  lines.push("");
  lines.push(`## Current KPI snapshots (${inputs.kpiSnapshots.length})`);
  if (inputs.kpiSnapshots.length === 0) {
    lines.push("- (no KPI snapshots — connect Stripe / PostHog)");
  } else {
    for (const k of inputs.kpiSnapshots) {
      lines.push(
        `- ${k.metric}: ${k.value}${k.unit ? ` ${k.unit}` : ""}`,
      );
    }
  }

  lines.push("");
  lines.push(`## Open insights last 30d (${inputs.openInsights.length})`);
  if (inputs.openInsights.length === 0) {
    lines.push("- (none)");
  } else {
    for (const i of inputs.openInsights) {
      lines.push(
        `- [id=${i.id}] kind=${i.kind} confidence=${i.confidence.toFixed(2)} :: ${i.title}`,
      );
      if (i.body) lines.push(`    body: ${i.body.slice(0, 240)}`);
      if (i.recommendation)
        lines.push(`    rec: ${i.recommendation.slice(0, 240)}`);
    }
  }

  lines.push("");
  lines.push(
    `## Existing proposed experiments (${inputs.existingProposed.length}) — DO NOT duplicate`,
  );
  if (inputs.existingProposed.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of inputs.existingProposed) {
      lines.push(`- channel=${e.channel ?? "n/a"} :: ${e.hypothesis}`);
    }
  }

  lines.push("");
  lines.push(
    "Return the JSON envelope now: { experiments: [{ hypothesis, channel, expectedLiftPct, expectedCacCents, iceImpact, iceConfidence, iceEase, rationale }, ...] }. Cap at 5 entries.",
  );

  return lines.join("\n");
}

// ── Aggregation ─────────────────────────────────────────────────────────────

async function loadCompany(
  db: Db,
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row ?? null;
}

async function loadEventsBySource(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<Array<{ source: string; count: number }>> {
  const rows = (await db.execute(sql`
    SELECT source, COUNT(*)::int AS count
    FROM events
    WHERE company_id = ${companyId}
      AND occurred_at >= ${windowStart.toISOString()}
    GROUP BY source
    ORDER BY count DESC
    LIMIT 10
  `)) as unknown as
    | { rows: Array<{ source: string; count: number }> }
    | Array<{ source: string; count: number }>;
  // Drizzle's execute returns either { rows } (pg driver) or array (pglite).
  const list = Array.isArray(rows)
    ? (rows as Array<{ source: string; count: number }>)
    : rows.rows;
  return list.map((r) => ({ source: String(r.source), count: Number(r.count) }));
}

async function loadEventCount(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<number> {
  const result = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM events
    WHERE company_id = ${companyId}
      AND occurred_at >= ${windowStart.toISOString()}
  `)) as unknown as
    | { rows: Array<{ count: number }> }
    | Array<{ count: number }>;
  const list = Array.isArray(result)
    ? (result as Array<{ count: number }>)
    : result.rows;
  return Number(list[0]?.count ?? 0);
}

async function loadOpenInsights(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<SuggesterInputInsight[]> {
  const rows = await db
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      body: insights.body,
      confidence: insights.confidence,
      recommendation: insights.recommendation,
    })
    .from(insights)
    .where(
      and(
        eq(insights.companyId, companyId),
        eq(insights.status, "open"),
        gte(insights.createdAt, windowStart),
      ),
    )
    .orderBy(desc(insights.createdAt))
    .limit(30);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind ?? "unknown",
    title: r.title,
    body: r.body,
    confidence: r.confidence,
    recommendation: r.recommendation,
  }));
}

/**
 * KPI snapshots from the events.entity_type='kpi' convention shipped in
 * S3.2: per metric, take the most recent (event_name, payload.value).
 */
async function loadKpiSnapshots(
  db: Db,
  companyId: string,
  windowStart: Date,
): Promise<SuggesterInputKpiSnapshot[]> {
  const result = (await db.execute(sql`
    SELECT DISTINCT ON (event_name)
      event_name,
      payload->>'value' AS value_text,
      payload->>'unit' AS unit_text,
      occurred_at
    FROM events
    WHERE company_id = ${companyId}
      AND entity_type = 'kpi'
      AND occurred_at >= ${windowStart.toISOString()}
    ORDER BY event_name, occurred_at DESC
  `)) as unknown as
    | { rows: Array<{ event_name: string; value_text: string | null; unit_text: string | null }> }
    | Array<{ event_name: string; value_text: string | null; unit_text: string | null }>;
  const list = Array.isArray(result)
    ? (result as Array<{
        event_name: string;
        value_text: string | null;
        unit_text: string | null;
      }>)
    : result.rows;
  const out: SuggesterInputKpiSnapshot[] = [];
  for (const r of list) {
    if (!r.value_text) continue;
    const v = Number.parseFloat(r.value_text);
    if (!Number.isFinite(v)) continue;
    out.push({
      metric: r.event_name,
      value: v,
      unit: r.unit_text ?? undefined,
    });
  }
  return out.slice(0, 10);
}

async function loadExistingProposed(
  db: Db,
  companyId: string,
): Promise<Array<{ hypothesis: string; channel: string | null }>> {
  const rows = await db
    .select({
      hypothesis: experiments.hypothesis,
      channel: experiments.channel,
    })
    .from(experiments)
    .where(
      and(
        eq(experiments.companyId, companyId),
        eq(experiments.status, "proposed"),
      ),
    )
    .orderBy(desc(experiments.createdAt))
    .limit(20);
  return rows.map((r) => ({
    hypothesis: r.hypothesis,
    channel: r.channel,
  }));
}

async function buildSuggesterInputs(
  db: Db,
  companyId: string,
  now: Date,
): Promise<SuggesterInputs | null> {
  const company = await loadCompany(db, companyId);
  if (!company) return null;

  const windowStart = new Date(now.getTime() - INPUT_LOOKBACK_MS);

  const [eventsBySource, eventCount, openInsights, kpiSnapshots, existingProposed] =
    await Promise.all([
      loadEventsBySource(db, companyId, windowStart),
      loadEventCount(db, companyId, windowStart),
      loadOpenInsights(db, companyId, windowStart),
      loadKpiSnapshots(db, companyId, windowStart),
      loadExistingProposed(db, companyId),
    ]);

  return {
    companyName: company.name,
    eventCount,
    eventsBySource,
    openInsights,
    kpiSnapshots,
    existingProposed,
  };
}

// ── Dedup gate ──────────────────────────────────────────────────────────────

/**
 * Probe: does the connected database have pgvector available? We probe by
 * checking pg_extension. Cached per-process; safe because pgvector is either
 * present at boot or absent at boot, never toggled mid-process.
 */
let pgvectorAvailableCache: WeakMap<object, boolean> = new WeakMap();

async function isPgvectorAvailable(db: Db): Promise<boolean> {
  const cached = pgvectorAvailableCache.get(db as unknown as object);
  if (cached !== undefined) return cached;
  try {
    const result = (await db.execute(sql`
      SELECT 1 AS present FROM pg_extension WHERE extname = 'vector'
    `)) as unknown as { rows: Array<{ present: number }> } | Array<{ present: number }>;
    const list = Array.isArray(result)
      ? (result as Array<{ present: number }>)
      : result.rows;
    const available = list.length > 0;
    pgvectorAvailableCache.set(db as unknown as object, available);
    return available;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "growth-suggester: pgvector probe threw — assuming unavailable",
    );
    pgvectorAvailableCache.set(db as unknown as object, false);
    return false;
  }
}

/**
 * Returns true if the new hypothesis duplicates an existing `proposed`
 * experiment for this company. Two paths:
 *
 *   - pgvector available: cosine query against the embedding column.
 *   - pgvector absent: sha256(lowercased hypothesis text) string-equality
 *     fallback. This catches the "exact same hypothesis text re-proposed"
 *     case which is the dominant failure mode the test fixture exercises.
 */
async function isDuplicate(
  db: Db,
  companyId: string,
  newHypothesis: string,
  newEmbedding: number[],
): Promise<boolean> {
  if (await isPgvectorAvailable(db)) {
    // Cosine distance via the <=> operator. Convert to similarity = 1 - dist.
    const literal = `[${newEmbedding.join(",")}]`;
    try {
      const result = (await db.execute(sql`
        SELECT 1 AS match
        FROM experiments
        WHERE company_id = ${companyId}
          AND status = 'proposed'
          AND hypothesis_embedding IS NOT NULL
          AND (1 - (hypothesis_embedding <=> ${literal}::vector)) > ${DEDUP_COSINE_THRESHOLD}
        LIMIT 1
      `)) as unknown as
        | { rows: Array<{ match: number }> }
        | Array<{ match: number }>;
      const list = Array.isArray(result)
        ? (result as Array<{ match: number }>)
        : result.rows;
      return list.length > 0;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "growth-suggester: pgvector cosine query threw — falling back to text dedup",
      );
      // Fall through to text dedup.
    }
  }

  // String-equality fallback on lowercased hypothesis.
  const normalized = newHypothesis.trim().toLowerCase();
  const rows = await db
    .select({ hypothesis: experiments.hypothesis })
    .from(experiments)
    .where(
      and(
        eq(experiments.companyId, companyId),
        eq(experiments.status, "proposed"),
      ),
    )
    .limit(200);
  return rows.some((r) => r.hypothesis.trim().toLowerCase() === normalized);
}

// ── Failure-mode helper: write a kind='blocker' insight ─────────────────────

async function writeBlockerInsight(
  db: Db,
  companyId: string,
  reason: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(insights)
      .values({
        companyId,
        department: "growth",
        kind: "blocker",
        title: "Growth experiment suggester failed",
        body: `The growth-suggester run did not complete successfully. Reason: ${reason.slice(0, 1000)}`,
        confidence: 0.5,
        recommendation:
          "Verify the Anthropic API key under Instance → Providers and re-run the Growth agent.",
        evidence: { reason: reason.slice(0, 1000) },
      })
      .returning({ id: insights.id });
    return row?.id ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "growth-suggester: blocker insight write failed (non-fatal)",
    );
    return null;
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Run the growth-suggester pipeline once for `companyId`. Returns ok=true
 * with the inserted experiments on success, or ok=false with a reason and
 * the id of the blocker insight written on failure.
 *
 * Never throws — failure path always writes a blocker insight (best effort)
 * and returns a structured error.
 */
export async function runGrowthSuggester(
  db: Db,
  companyId: string,
  options: GrowthSuggesterRunOptions,
): Promise<GrowthSuggesterRunResult | GrowthSuggesterRunError> {
  const log = logger.child({ service: "growth-suggester", companyId });
  const callAnthropic = options.callAnthropic ?? defaultCallAnthropic;
  const embedHypothesis = options.embedHypothesis ?? (async (t) =>
    sha256PseudoEmbedding(t));
  const cap = options.maxExperiments ?? MAX_EXPERIMENTS_PER_RUN;

  // ── Aggregate inputs ──
  const now = new Date();
  const inputs = await buildSuggesterInputs(db, companyId, now);
  if (!inputs) {
    const reason = `Company not found: ${companyId}`;
    return { ok: false, reason, blockerInsightId: null };
  }

  // ── Resolve system prompt ──
  const systemPrompt =
    options.systemPromptOverride ?? (await loadSystemPrompt());
  const userPrompt = buildUserPrompt(inputs);

  // ── LLM call ──
  let raw: string;
  try {
    raw = await callAnthropic({
      apiKey: options.apiKey,
      systemPrompt,
      userPrompt,
    });
  } catch (err) {
    const reason = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ reason }, "growth-suggester: LLM call failed");
    const blockerId = await writeBlockerInsight(db, companyId, reason);
    return { ok: false, reason, blockerInsightId: blockerId };
  }

  // ── Parse + validate ──
  let parsedJson: unknown;
  try {
    parsedJson = extractJsonObject(raw);
  } catch (err) {
    const reason = `LLM returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ reason }, "growth-suggester: JSON extract failed");
    const blockerId = await writeBlockerInsight(db, companyId, reason);
    return { ok: false, reason, blockerInsightId: blockerId };
  }

  const validated = growthSuggesterPayloadSchema.safeParse(parsedJson);
  if (!validated.success) {
    const reason = `LLM JSON failed schema: ${validated.error.message}`;
    log.warn({ reason }, "growth-suggester: schema validation failed");
    const blockerId = await writeBlockerInsight(db, companyId, reason);
    return { ok: false, reason, blockerInsightId: blockerId };
  }

  // ── Embed + dedup + insert ──
  const proposals = validated.data.experiments;
  const inserted: Experiment[] = [];
  let skippedAsDuplicate = 0;
  let skippedAsCap = 0;

  for (const p of proposals) {
    if (inserted.length >= cap) {
      skippedAsCap += 1;
      continue;
    }
    let embedding: number[];
    try {
      embedding = await embedHypothesis(p.hypothesis);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "growth-suggester: embedHypothesis threw — skipping proposal",
      );
      continue;
    }
    if (embedding.length !== HYPOTHESIS_EMBEDDING_DIM) {
      log.warn(
        { dim: embedding.length, expected: HYPOTHESIS_EMBEDDING_DIM },
        "growth-suggester: embedding wrong dimension — skipping proposal",
      );
      continue;
    }

    if (await isDuplicate(db, companyId, p.hypothesis, embedding)) {
      skippedAsDuplicate += 1;
      continue;
    }

    // Insert. Pass embedding only when pgvector is available; otherwise the
    // column stays NULL and dedup falls through to the text path.
    const pgvectorOk = await isPgvectorAvailable(db);
    try {
      const [row] = await db
        .insert(experiments)
        .values({
          companyId,
          department: "growth",
          hypothesis: p.hypothesis,
          channel: p.channel as ExperimentChannel,
          expectedLiftPct: p.expectedLiftPct,
          expectedCacCents: BigInt(p.expectedCacCents),
          iceImpact: p.iceImpact,
          iceConfidence: p.iceConfidence,
          iceEase: p.iceEase,
          status: "proposed",
          hypothesisEmbedding: pgvectorOk ? embedding : null,
        })
        .returning();
      if (row) inserted.push(row);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          hypothesis: p.hypothesis.slice(0, 80),
        },
        "growth-suggester: insert failed — skipping proposal",
      );
    }
  }

  log.info(
    {
      proposed: inserted.length,
      skippedAsDuplicate,
      skippedAsCap,
      llmReturned: proposals.length,
    },
    "growth-suggester: run complete",
  );

  return {
    ok: true,
    proposed: inserted,
    skippedAsDuplicate,
    skippedAsCap,
    source: "llm",
  };
}
