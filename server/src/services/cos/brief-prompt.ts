/**
 * brief-prompt.ts — LLM prompt template + Zod schema + parser for the daily
 * founder brief (S3.3).
 *
 * Single source of truth for:
 *   - the system prompt (Chief-of-Staff persona, terse tone, founder mode)
 *   - the user-prompt builder (deterministic from inputs — same data → same
 *     prompt, easy to snapshot in tests)
 *   - the Anthropic call (mirrors weekly-wrap-generator.ts: Messages API,
 *     model claude-sonnet-4-6, 60s timeout, x-api-key header, 2023-06-01
 *     anthropic-version header)
 *   - the structured-output Zod schema + parser, with strict caps:
 *       5 KPI movements, 3 anomalies, 3 blockers, 3 opportunities,
 *       exactly 3 top actions
 *   - the synthesized fallback brief used when the LLM returns malformed
 *     JSON or the call fails — the founder still sees something instead
 *     of silence (also written to insights as a kind='blocker' marker).
 *   - the empty-workspace welcome brief (no LLM call needed when there is
 *     no signal at all — saves a token round-trip on day 0).
 *
 * Confidence-aware tone:
 *   When input data is sparse (events count < 100 in the lookback window),
 *   the prompt instructs the model to prefix the headline with
 *   "Limited data — " so the founder doesn't read sparse-signal noise as
 *   high-confidence advice. The threshold is intentionally generous; better
 *   to under-promise than over-promise.
 *
 * Idempotency contract:
 *   Callers (the cron + the on-demand POST) MUST do the (companyId, forDate)
 *   uniqueness check OUTSIDE this service. This module is pure
 *   "given inputs → return parsed brief"; it does not touch the DB.
 *   Mirrors weekly-wrap-generator's separation of concerns.
 *
 * Why a hand-rolled fetch and not the Anthropic SDK:
 *   The codebase pattern (weekly-wrap-generator.ts, conversation-extractor.ts)
 *   uses bare fetch + the Messages API directly. Same model
 *   (claude-sonnet-4-6), same anthropic-version header, same 60s timeout.
 *   Diverging here (e.g. pulling in the SDK) would be inconsistent and add a
 *   transitive dep without buying us caching/streaming/etc.
 */

import { z } from "zod";

// ── Anthropic configuration (mirrors weekly-wrap-generator) ─────────────────

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const NARRATIVE_MODEL = "claude-sonnet-4-6";
const NARRATIVE_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2048;

// Sparse-data threshold — below this many input signal items (events +
// open insights), the prompt instructs the model to prefix the headline
// with "Limited data — ". 100 is a deliberately generous bar.
export const SPARSE_DATA_THRESHOLD = 100;

// ── Public types — wire shape returned to the caller ────────────────────────

export type BriefInputKpiSnapshot = {
  metric: string;
  /** Yesterday's value, formatted human-friendly (e.g. "$12,400" or "184"). */
  from: string;
  /** Today's value, same format. */
  to: string;
  /** Pre-computed delta string (e.g. "+12%" or "-3"). Service supplies this
   *  rather than asking the LLM to compute it — math hallucination is the
   *  most expensive failure mode in a financial brief. */
  delta: string;
};

export type BriefInputInsight = {
  id: string;
  kind: string;
  title: string;
  body: string;
  confidence: number;
  recommendation?: string | null;
};

export type BriefInputApproval = {
  id: string;
  type: string;
  title: string | null;
  createdAt: Date;
};

export type BriefInputStalledWorkflow = {
  id: string;
  title: string;
  stalledFor: string; // human-friendly e.g. "3 days"
};

export type BriefInputs = {
  companyName: string;
  forDate: Date;
  /** Yesterday's KPI snapshots (computed from companies.metrics + events). */
  kpiSnapshots: BriefInputKpiSnapshot[];
  /** Open insights from the last 24h, all kinds. */
  openInsights: BriefInputInsight[];
  /** Pending approvals awaiting founder review. */
  pendingApprovals: BriefInputApproval[];
  /** Stalled issues / decisions / approvals. */
  stalledWorkflows: BriefInputStalledWorkflow[];
  /** kind='opportunity' insights with confidence>0.7 status='open'. */
  topOpportunities: BriefInputInsight[];
  /** Total event count in the 24h lookback window. Used for sparse-data check. */
  eventCount: number;
};

// ── System prompt ───────────────────────────────────────────────────────────

export const DAILY_BRIEF_SYSTEM_PROMPT =
  "You are the Chief of Staff drafting the daily morning brief for a founder. " +
  "Output ONLY a JSON object — no markdown fences, no commentary, no preamble. " +
  "The JSON object MUST have these exact top-level keys: " +
  '"headline", "kpiMovements", "anomalies", "blockers", "opportunities", "topThreeActions". ' +
  "Tone: terse, founder-focused, action-oriented. Every line earns its place. " +
  "Forbidden adjectives: 'amazing', 'crucial', 'robust', 'leverage', 'synergy', 'exciting'. " +
  "Headline example: 'MRR up 14% on LinkedIn-driven trial conversions; activation drop at step 2 needs attention.' " +
  "Caps you MUST respect: at most 5 kpiMovements, 3 anomalies, 3 blockers, 3 opportunities, " +
  "and EXACTLY 3 topThreeActions (always 3, never 2 or 4). " +
  "When input data is sparse (the user message will say so), prefix headline with 'Limited data — ' " +
  "and tone down assertiveness in commentary fields. " +
  "Each anomaly MUST set insightId from the supplied insight ids — never invent one. " +
  "Each opportunity MUST set insightId from the supplied opportunity ids. " +
  "topThreeActions[].approvalId, when present, MUST come from the supplied pending-approvals list.";

// ── Zod schema — validates LLM output AND DB read shape ─────────────────────

const kpiMovementSchema = z.object({
  metric: z.string().min(1).max(100),
  from: z.string().min(1).max(100),
  to: z.string().min(1).max(100),
  delta: z.string().min(1).max(100),
  commentary: z.string().min(1).max(500),
});

const anomalySchema = z.object({
  title: z.string().min(1).max(200),
  insightId: z.string().min(1).max(100),
});

const blockerSchema = z.object({
  title: z.string().min(1).max(200),
  resolutionAction: z.string().min(1).max(500),
});

const opportunitySchema = z.object({
  title: z.string().min(1).max(200),
  expectedImpact: z.string().min(1).max(300),
  insightId: z.string().min(1).max(100),
});

const topActionSchema = z.object({
  action: z.string().min(1).max(300),
  rationale: z.string().min(1).max(500),
  approvalId: z.string().min(1).max(100).optional(),
});

/**
 * Strict shape of the LLM-returned brief. Caps mirror the system prompt — if
 * the model overshoots we slice rather than throwing, since "too many ideas"
 * is a fixable output, not a corrupt one. Under-shoot (e.g. 2 actions when
 * we ask for 3) IS treated as malformed and falls back to the synthesized
 * brief — three top actions is the contract.
 */
export const dailyBriefPayloadSchema = z.object({
  headline: z.string().min(1).max(500),
  kpiMovements: z.array(kpiMovementSchema).max(20),
  anomalies: z.array(anomalySchema).max(10),
  blockers: z.array(blockerSchema).max(10),
  opportunities: z.array(opportunitySchema).max(10),
  topThreeActions: z.array(topActionSchema).min(3).max(3),
});

export type DailyBriefPayloadParsed = z.infer<typeof dailyBriefPayloadSchema>;

// ── Caller — DI'd Anthropic so tests don't hit the network ──────────────────

export type AnthropicJsonCaller = (params: {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

// ── User prompt builder ─────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);
}

/**
 * Build the user prompt deterministically — same `BriefInputs` always
 * produces the same string, which makes prompt-snapshot tests trivial.
 *
 * Format choices:
 *   - Plain text with section headers, not JSON. The model is far better
 *     at structured-OUTPUT JSON when the input is prose; pure-JSON inputs
 *     leak into the output and cause it to over-mirror the input shape.
 *   - Numbered ids on insights/approvals so the model can reference them
 *     precisely (e.g. "insightId: ins_abc123") in the structured output.
 */
export function buildUserPrompt(inputs: BriefInputs): string {
  const lines: string[] = [];
  const isSparse = inputs.eventCount < SPARSE_DATA_THRESHOLD;

  lines.push(`Company: ${inputs.companyName}`);
  lines.push(`Date: ${fmtDate(inputs.forDate)}`);
  if (isSparse) {
    lines.push(
      `Signal volume: SPARSE (only ${inputs.eventCount} events in lookback) — prefix headline "Limited data — ".`,
    );
  } else {
    lines.push(`Signal volume: NORMAL (${inputs.eventCount} events).`);
  }

  // KPI snapshots — service has already computed deltas, so the model
  // should NOT recompute. Tell it that explicitly.
  lines.push("");
  lines.push("## KPI snapshots (yesterday → today)");
  if (inputs.kpiSnapshots.length === 0) {
    lines.push("- (no KPI deltas this window)");
  } else {
    for (const k of inputs.kpiSnapshots) {
      lines.push(`- ${k.metric}: ${k.from} → ${k.to} (${k.delta})`);
    }
    lines.push(
      "Use the provided from/to/delta values verbatim — do NOT recompute math.",
    );
  }

  // Open insights (last 24h, all kinds). Provide ids verbatim so the
  // model can reference them in anomalies[].insightId.
  lines.push("");
  lines.push(`## Open insights last 24h (${inputs.openInsights.length})`);
  if (inputs.openInsights.length === 0) {
    lines.push("- (none)");
  } else {
    for (const i of inputs.openInsights) {
      lines.push(
        `- [id=${i.id}] kind=${i.kind} confidence=${i.confidence.toFixed(2)} :: ${i.title}`,
      );
      if (i.body) lines.push(`    body: ${i.body.slice(0, 280)}`);
      if (i.recommendation)
        lines.push(`    rec: ${i.recommendation.slice(0, 280)}`);
    }
  }

  // Pending approvals.
  lines.push("");
  lines.push(`## Pending approvals (${inputs.pendingApprovals.length})`);
  if (inputs.pendingApprovals.length === 0) {
    lines.push("- (none)");
  } else {
    for (const a of inputs.pendingApprovals) {
      const t = a.title ?? "(no title)";
      lines.push(`- [approvalId=${a.id}] type=${a.type} :: ${t}`);
    }
  }

  // Stalled workflows.
  lines.push("");
  lines.push(`## Stalled workflows (${inputs.stalledWorkflows.length})`);
  if (inputs.stalledWorkflows.length === 0) {
    lines.push("- (none)");
  } else {
    for (const s of inputs.stalledWorkflows) {
      lines.push(`- ${s.title} — stalled for ${s.stalledFor}`);
    }
  }

  // Top opportunities (kind='opportunity', confidence>0.7, status='open').
  lines.push("");
  lines.push(`## Top opportunities (${inputs.topOpportunities.length})`);
  if (inputs.topOpportunities.length === 0) {
    lines.push("- (none)");
  } else {
    for (const o of inputs.topOpportunities) {
      lines.push(
        `- [id=${o.id}] confidence=${o.confidence.toFixed(2)} :: ${o.title}`,
      );
      if (o.recommendation)
        lines.push(`    rec: ${o.recommendation.slice(0, 280)}`);
    }
  }

  lines.push("");
  lines.push(
    "Return the JSON object now. Caps: 5 kpiMovements, 3 anomalies, 3 blockers, 3 opportunities, EXACTLY 3 topThreeActions.",
  );

  return lines.join("\n");
}

// ── Default Anthropic caller — same shape as weekly-wrap-generator ──────────

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

// ── JSON extractor — tolerant of fenced code-blocks and leading prose ───────

/**
 * Extracts the first JSON object from a string, handling the common LLM
 * malformations we've seen in production:
 *   - "```json\n{...}\n```" code fences
 *   - leading/trailing prose ("Here's the brief:\n{...}")
 *   - markdown bold around the JSON
 *
 * If no JSON object can be found, throws — the caller falls back to the
 * synthesized brief.
 */
export function extractJsonObject(raw: string): unknown {
  // Strip code-fence wrappers.
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch?.[1]) s = fenceMatch[1].trim();

  // Find the first { and last } — naive but robust enough for these
  // payloads. Brace-counting would catch nested-object edge cases that
  // we don't actually need given the schema.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("No JSON object found in LLM response");
  }
  const slice = s.slice(first, last + 1);
  return JSON.parse(slice);
}

// ── Main entry — generate brief from inputs ────────────────────────────────

export type GenerateBriefOptions = {
  /** Dependency injection for tests. */
  callAnthropic?: AnthropicJsonCaller;
  /** Required Anthropic API key (caller resolves). */
  apiKey: string;
};

export type GenerateBriefResult =
  | { ok: true; payload: DailyBriefPayloadParsed; source: "llm" }
  | {
      ok: false;
      payload: DailyBriefPayloadParsed;
      source: "fallback";
      reason: string;
    };

/**
 * Generate the daily brief payload for `inputs`. Always returns a payload —
 * if the LLM call fails or the response is malformed JSON, we synthesize a
 * fallback brief and surface the failure reason. Never throws.
 *
 * The caller (cron + route) is responsible for:
 *   - persisting the payload (upsert on (companyId, forDate))
 *   - on `source: 'fallback'`, additionally writing a kind='blocker' insight
 *     so the founder sees the LLM hiccup explicitly in their normal surface
 */
export async function generateDailyBrief(
  inputs: BriefInputs,
  opts: GenerateBriefOptions,
): Promise<GenerateBriefResult> {
  const callAnthropic = opts.callAnthropic ?? defaultCallAnthropic;

  const systemPrompt = DAILY_BRIEF_SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(inputs);

  let raw: string;
  try {
    raw = await callAnthropic({
      apiKey: opts.apiKey,
      systemPrompt,
      userPrompt,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      payload: synthesizeFallbackBrief(inputs, `LLM call failed: ${reason}`),
      source: "fallback",
      reason,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = extractJsonObject(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      payload: synthesizeFallbackBrief(
        inputs,
        `LLM returned malformed JSON: ${reason}`,
      ),
      source: "fallback",
      reason,
    };
  }

  const validated = dailyBriefPayloadSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      payload: synthesizeFallbackBrief(
        inputs,
        `LLM JSON failed schema: ${validated.error.message}`,
      ),
      source: "fallback",
      reason: validated.error.message,
    };
  }

  // Apply caps in case the model overshot. Under-shoot on topThreeActions
  // already failed the schema (.min(3).max(3)).
  const capped: DailyBriefPayloadParsed = {
    headline: validated.data.headline,
    kpiMovements: validated.data.kpiMovements.slice(0, 5),
    anomalies: validated.data.anomalies.slice(0, 3),
    blockers: validated.data.blockers.slice(0, 3),
    opportunities: validated.data.opportunities.slice(0, 3),
    topThreeActions: validated.data.topThreeActions.slice(0, 3),
  };

  return { ok: true, payload: capped, source: "llm" };
}

// ── Welcome brief for empty workspaces ──────────────────────────────────────

/**
 * Brief for a workspace with no signal at all (no events, no insights, no
 * approvals). Sidesteps the LLM call entirely — saves a token round-trip on
 * day 0 and the message is more useful as deterministic copy than as
 * model-generated boilerplate.
 *
 * Heuristic: a workspace is "empty" when there are zero events AND zero
 * open insights AND zero pending approvals. Once any of those fire we go
 * back to the LLM path.
 */
export function isEmptyWorkspace(inputs: BriefInputs): boolean {
  return (
    inputs.eventCount === 0 &&
    inputs.openInsights.length === 0 &&
    inputs.pendingApprovals.length === 0 &&
    inputs.kpiSnapshots.length === 0 &&
    inputs.stalledWorkflows.length === 0 &&
    inputs.topOpportunities.length === 0
  );
}

export function buildWelcomeBrief(
  inputs: BriefInputs,
): DailyBriefPayloadParsed {
  return {
    headline: `Welcome to ${inputs.companyName} — connect an integration to get your first signal.`,
    kpiMovements: [],
    anomalies: [],
    blockers: [],
    opportunities: [],
    topThreeActions: [
      {
        action: "Connect Stripe to surface MRR and revenue movements.",
        rationale:
          "Revenue is the highest-signal KPI — pulling it in unlocks anomaly detection.",
      },
      {
        action: "Connect PostHog or your product analytics for activation data.",
        rationale:
          "Activation funnel deltas are how the brief surfaces drop-offs you can act on.",
      },
      {
        action: "Add your first goal under Goals → New goal.",
        rationale:
          "Goals anchor the brief — without one, the CoS has nothing to measure progress against.",
      },
    ],
  };
}

// ── Synthesized fallback brief — never lets the founder see silence ─────────

/**
 * When the LLM call fails or the response is unparseable, synthesize a
 * deterministic brief from the inputs the cron already aggregated. Better
 * to surface the raw signal than throw away the morning send.
 *
 * The cron also writes a kind='blocker' insight when this path fires, so
 * the founder can see in the normal surface that the LLM had a hiccup.
 */
export function synthesizeFallbackBrief(
  inputs: BriefInputs,
  reason: string,
): DailyBriefPayloadParsed {
  const isSparse = inputs.eventCount < SPARSE_DATA_THRESHOLD;
  const prefix = isSparse ? "Limited data — " : "";

  // Headline — lean on whatever signal we have.
  let headline: string;
  if (inputs.kpiSnapshots.length > 0) {
    const top = inputs.kpiSnapshots[0]!;
    headline = `${prefix}${top.metric}: ${top.from} → ${top.to} (${top.delta}).`;
  } else if (inputs.pendingApprovals.length > 0) {
    headline = `${prefix}${inputs.pendingApprovals.length} approval${inputs.pendingApprovals.length === 1 ? "" : "s"} waiting on you.`;
  } else if (inputs.openInsights.length > 0) {
    headline = `${prefix}${inputs.openInsights.length} new insight${inputs.openInsights.length === 1 ? "" : "s"} surfaced overnight.`;
  } else {
    headline = `${prefix}Quiet morning — no movement yet.`;
  }

  const kpiMovements: DailyBriefPayloadParsed["kpiMovements"] = inputs.kpiSnapshots
    .slice(0, 5)
    .map((k) => ({
      metric: k.metric,
      from: k.from,
      to: k.to,
      delta: k.delta,
      commentary: "Auto-generated from raw signal (LLM unavailable).",
    }));

  const anomalies: DailyBriefPayloadParsed["anomalies"] = inputs.openInsights
    .filter((i) => i.kind === "kpi_anomaly")
    .slice(0, 3)
    .map((i) => ({ title: i.title, insightId: i.id }));

  const blockerInsights = inputs.openInsights
    .filter((i) => i.kind === "blocker")
    .slice(0, 2)
    .map<DailyBriefPayloadParsed["blockers"][number]>((i) => ({
      title: i.title,
      resolutionAction: i.recommendation ?? "Review and decide a next step.",
    }));

  // Always include the "LLM unavailable" marker as a blocker so the
  // founder can see the synthesized status. It fills the cap when
  // there are no real blockers in the inputs.
  const blockers: DailyBriefPayloadParsed["blockers"] = [
    ...blockerInsights,
    {
      title: "Daily brief synthesized without LLM.",
      resolutionAction: `Reason: ${reason.slice(0, 300)}. Brief will retry tomorrow; raw signal preserved above.`,
    },
  ].slice(0, 3);

  const opportunities: DailyBriefPayloadParsed["opportunities"] = inputs.topOpportunities
    .slice(0, 3)
    .map((o) => ({
      title: o.title,
      expectedImpact: o.recommendation ?? "Review the insight for details.",
      insightId: o.id,
    }));

  // Top 3 actions — derived from approvals, opportunities, then a static
  // "review the brief" filler. Always exactly 3 to satisfy the schema.
  const fromApprovals: DailyBriefPayloadParsed["topThreeActions"] = inputs.pendingApprovals
    .slice(0, 2)
    .map((a) => ({
      action: `Review approval: ${a.title ?? a.type}`,
      rationale: `Pending since ${fmtDate(a.createdAt)} — unblocks downstream work.`,
      approvalId: a.id,
    }));

  const fromOpportunities: DailyBriefPayloadParsed["topThreeActions"] = inputs.topOpportunities
    .slice(0, 3 - fromApprovals.length)
    .map((o) => ({
      action: `Pursue: ${o.title}`,
      rationale: o.recommendation ?? "High-confidence opportunity surfaced.",
    }));

  const filler: DailyBriefPayloadParsed["topThreeActions"] = [
    {
      action: "Review the synthesized brief and re-run when signal fills in.",
      rationale: "LLM was unavailable for this run; the auto-fallback path fired.",
    },
    {
      action: "Connect or check an integration so tomorrow's brief has more signal.",
      rationale: "Higher event volume gives the CoS more to reason about.",
    },
    {
      action: "Triage the open insights surfaced overnight.",
      rationale: "Insights expire — acting on them today preserves the chain of context.",
    },
  ];

  const topThreeActions: DailyBriefPayloadParsed["topThreeActions"] = [
    ...fromApprovals,
    ...fromOpportunities,
    ...filler,
  ].slice(0, 3);

  return {
    headline,
    kpiMovements,
    anomalies,
    blockers,
    opportunities,
    topThreeActions,
  };
}
