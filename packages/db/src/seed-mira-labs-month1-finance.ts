/**
 * seed-mira-labs-month1-finance.ts — Wave 6 of the Mira Labs Month-1 dogfood seed.
 *
 * Scope (per .planning/loop-2026-05-13-04/MIRA-LABS-MONTH-1.md §6 Agent F):
 *   - cost_events        : 175 rows (one per heartbeat_run)
 *   - finance_events     : 30 rows (revenue + agent_cost + tooling + operating)
 *   - marketing_spend    : 3 rows (LinkedIn / Partnerships / Content)
 *   - budget_policies    : 3 rows (one per agent, monthly window)
 *   - budget_incidents   : 2 rows (Day 12 Theo spike resolved, Day 26 Maya open)
 *   - events             : 80 rows (stripe 25, slack 35, linkedin 8, posthog 12)
 *   - workflows          : 2 rows (welcome retainer, monthly nudge) — OPTIONAL
 *   - workflow_runs      : 6 rows — OPTIONAL
 *   - activity_log       : ~30 non-run state transitions (issue.status_changed,
 *                          agent_config.revised, integration.connected)
 *   - UPDATE agents.spent_monthly_cents per agent
 *   - UPDATE companies.spent_monthly_cents (= sum across agents)
 *
 * Depends on Wave 1 (Agent A — runs.ts) having already run: it queries
 * heartbeat_runs directly rather than reading runs.json (the spec recommends
 * the JSON ledger but the DB IS the source of truth here, and Wave 1's
 * runs.json may not exist if the script was invoked from a non-repo-root cwd).
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS_MONTH1=1 \
 *     DATABASE_URL="postgres://founderos:founderos@127.0.0.1:54329/founderos" \
 *     pnpm --filter @founderos/db exec tsx src/seed-mira-labs-month1-finance.ts
 *
 * Re-run safety: every insert is preceded by an idempotency check against a
 * natural key (e.g. heartbeatRunId for cost_events, (companyId, source,
 * dedupKey) for events). The whole script wraps in a transaction. Re-running
 * is a no-op once the target row counts are met.
 *
 * Hard limits (council carry-over):
 *   - NEVER set companies.is_demo = true  (DB trigger 0109 rejects)
 *   - NEVER INSERT into instance_api_keys (council condition #4)
 *   - NO real Stripe API calls — events.payload is synthetic Stripe-shape only
 *   - All metadata_json columns tagged { persona: "mira-labs-dogfood" }
 *   - All timestamps in the past (cap at "now" = 2026-05-13 IST)
 */

import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb } from "./client.js";
import {
  companies,
  agents,
  activityLog,
  budgetIncidents,
  budgetPolicies,
  costEvents,
  events,
  financeEvents,
  heartbeatRuns,
  marketingSpend,
  workflowRuns,
  workflows,
} from "./schema/index.js";

// ─── Gates ────────────────────────────────────────────────────────────────────
if (process.env.FOUNDEROS_SEED_MIRA_LABS_MONTH1 !== "1") {
  console.error(
    "[seed-mira-labs-month1-finance] Refusing: set FOUNDEROS_SEED_MIRA_LABS_MONTH1=1",
  );
  process.exit(1);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs-month1-finance] DATABASE_URL is required");
  process.exit(1);
}

const PERSONA_TAG = "mira-labs-dogfood";
const ANITA_AUTH_UID = "9b29fdf9-2ddb-4919-8fd2-77e4640849c9";

// ─── Time helpers ─────────────────────────────────────────────────────────────
const IST_OFFSET_MIN = 330; // +05:30
const RUN_NOW = new Date("2026-05-13T08:30:00+05:30");

function ist(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(utc - IST_OFFSET_MIN * 60_000);
}

function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

function clampToRunNow(d: Date): Date {
  return d.getTime() > RUN_NOW.getTime() ? RUN_NOW : d;
}

function isoDate(d: Date): string {
  // YYYY-MM-DD in IST. Used for marketing_spend.period_* date columns.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ─── DB setup ─────────────────────────────────────────────────────────────────
const db = createDb(DATABASE_URL);

console.log("[seed-mira-labs-month1-finance] Looking up Mira Labs company + agents…");

const companyRowRaw = (await db.execute(
  sql`SELECT id FROM companies WHERE metadata->>'persona' = ${PERSONA_TAG} LIMIT 1`,
)) as unknown as Array<{ id: string }> | { rows: Array<{ id: string }> };
const companyRow = Array.isArray(companyRowRaw)
  ? companyRowRaw[0]
  : (companyRowRaw.rows ?? [])[0];

if (!companyRow) {
  console.error(
    "[seed-mira-labs-month1-finance] Mira Labs company not found. Run scripts/seed-mira-labs.ts + seed-mira-labs-month1-runs.ts first.",
  );
  process.exit(1);
}
const MIRA = companyRow.id;

const agentRows = await db
  .select({
    id: agents.id,
    name: agents.name,
    adapterType: agents.adapterType,
    adapterConfig: agents.adapterConfig,
    budgetMonthlyCents: agents.budgetMonthlyCents,
  })
  .from(agents)
  .where(eq(agents.companyId, MIRA));

const findAgent = (name: string) => {
  const a = agentRows.find((r) => r.name === name);
  if (!a) throw new Error(`Agent not found: ${name}`);
  return a;
};
const MAYA = findAgent("Maya");
const THEO = findAgent("Theo");
const IRIS = findAgent("Iris");

console.log(
  `[seed-mira-labs-month1-finance] MIRA=${MIRA} MAYA=${MAYA.id} THEO=${THEO.id} IRIS=${IRIS.id}`,
);

// Wave 1 prerequisite check: at least the expected heartbeat_runs must exist.
const hbCountRows = await db
  .select({ id: heartbeatRuns.id })
  .from(heartbeatRuns)
  .where(eq(heartbeatRuns.companyId, MIRA));
if (hbCountRows.length < 175) {
  console.error(
    `[seed-mira-labs-month1-finance] Expected ≥175 heartbeat_runs, found ${hbCountRows.length}. Run Wave 1 (seed-mira-labs-month1-runs.ts) first.`,
  );
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type AgentKey = "maya" | "theo" | "iris";

function agentKeyForId(agentId: string): AgentKey {
  if (agentId === MAYA.id) return "maya";
  if (agentId === THEO.id) return "theo";
  if (agentId === IRIS.id) return "iris";
  throw new Error(`Unknown agent id: ${agentId}`);
}

function modelForAgent(k: AgentKey): string {
  if (k === "maya") return "claude-opus-4-6";
  if (k === "theo") return "gpt-4.1-mini";
  return "claude-sonnet-4-6";
}

function providerForAgent(k: AgentKey): "anthropic" | "openai" {
  return k === "theo" ? "openai" : "anthropic";
}

// Cost ranges per spec §3.21 (cents per run):
//   Maya Opus 4.6   : 5–12¢
//   Theo 4.1-mini   : 1–3¢
//   Iris Sonnet 4.6 : 3–6¢
// We derive from usage_json when present (already shaped by Wave 1) else
// use a deterministic seed-based value within the band.
function costCentsForRun(k: AgentKey, usage: Record<string, unknown> | null, seed: number): {
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  const u = usage ?? {};
  const usageInput = typeof u.input_tokens === "number" ? (u.input_tokens as number) : 0;
  const usageOutput = typeof u.output_tokens === "number" ? (u.output_tokens as number) : 0;
  const usageCached = typeof u.cached_input_tokens === "number" ? (u.cached_input_tokens as number) : 0;
  const usageCostUsd = typeof u.cost_usd === "number" ? (u.cost_usd as number) : null;

  // Default seed-based band cents (deterministic by run idx).
  // Maya: 5..12, Theo: 1..3, Iris: 3..6.
  let bandLo = 5,
    bandHi = 12;
  if (k === "theo") {
    bandLo = 1;
    bandHi = 3;
  } else if (k === "iris") {
    bandLo = 3;
    bandHi = 6;
  }
  const range = bandHi - bandLo + 1;
  // Seed-based variance is the dominant signal — keeps the per-agent monthly
  // spend close to the spec target (Maya ~450c, Theo ~180c, Iris ~140c).
  // The usage_json cost_usd from Wave 1's emission is informational; using it
  // directly would either clamp everyone to band ceiling (Maya) or floor
  // (Theo/Iris). Blending: seed-based mid value + a small jitter derived
  // from usage_json if present.
  let bandCents = bandLo + (seed % range);
  if (usageCostUsd != null) {
    // Small jitter: keep the LSB-derived ordinal of the cost_usd to add ±1
    // around the seed value, then re-clamp into the band.
    const jitter = (Math.round(usageCostUsd * 1000) % 3) - 1;
    bandCents = Math.min(bandHi, Math.max(bandLo, bandCents + jitter));
  }

  const inputTokens = usageInput || (k === "maya" ? 4200 : k === "theo" ? 2500 : 3500) + (seed % 500);
  const outputTokens = usageOutput || (k === "maya" ? 850 : k === "theo" ? 600 : 500) + (seed % 200);
  const cachedInputTokens = usageCached || (k === "iris" ? Math.floor(inputTokens * 0.2) : k === "maya" ? Math.floor(inputTokens * 0.25) : 0);

  return { costCents: bandCents, inputTokens, outputTokens, cachedInputTokens };
}

// ─── Main transaction ─────────────────────────────────────────────────────────

const summary = {
  costEvents: 0,
  financeEvents: 0,
  marketingSpend: 0,
  budgetPolicies: 0,
  budgetIncidents: 0,
  events: 0,
  workflows: 0,
  workflowRuns: 0,
  activityLog: 0,
  agentsUpdated: 0,
  companyUpdated: 0,
};

await db.transaction(async (tx) => {
  // ─── 1. cost_events (175 — one per heartbeat_run) ─────────────────────────
  console.log("[seed-mira-labs-month1-finance] cost_events…");

  // Idempotency: skip if we already have ≥175 cost_events rows.
  const existingCostCount = await tx
    .select({ id: costEvents.id })
    .from(costEvents)
    .where(eq(costEvents.companyId, MIRA));
  if (existingCostCount.length >= 175) {
    console.log(
      `[seed-mira-labs-month1-finance] cost_events already at target (${existingCostCount.length}). Skipping cost_events insert.`,
    );
  } else {
    // Fetch all runs sorted by startedAt for stable seed indexing.
    const runs = await tx
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, MIRA))
      .orderBy(heartbeatRuns.startedAt);

    // Look up which heartbeat_run_ids already have a cost_event so we only
    // insert the missing ones (handles a half-inserted prior run).
    const existingForRuns = await tx
      .select({ runId: costEvents.heartbeatRunId })
      .from(costEvents)
      .where(eq(costEvents.companyId, MIRA));
    const haveCostFor = new Set(
      existingForRuns
        .map((r) => r.runId)
        .filter((x): x is string => typeof x === "string"),
    );

    const rowsToInsert: Array<typeof costEvents.$inferInsert> = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      if (haveCostFor.has(r.id)) continue;
      const k = agentKeyForId(r.agentId);
      const usage = (r.usageJson ?? null) as Record<string, unknown> | null;
      const { costCents, inputTokens, outputTokens, cachedInputTokens } =
        costCentsForRun(k, usage, i);
      // occurredAt = finishedAt for completed runs; for running rows fall
      // back to startedAt (cost is incurred as the tokens stream).
      const occurredAt = clampToRunNow(r.finishedAt ?? r.startedAt ?? RUN_NOW);
      rowsToInsert.push({
        companyId: MIRA,
        agentId: r.agentId,
        heartbeatRunId: r.id,
        provider: providerForAgent(k),
        biller: providerForAgent(k),
        billingType: "llm_api_per_token",
        model: modelForAgent(k),
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents,
        occurredAt,
      });
    }

    const CHUNK = 100;
    for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
      if (rowsToInsert.length === 0) break;
      await tx.insert(costEvents).values(rowsToInsert.slice(i, i + CHUNK));
    }
    summary.costEvents = rowsToInsert.length;
  }

  // ─── 2. budget_policies (3 — one per agent) ───────────────────────────────
  // Required for budget_incidents.policy_id FK. UNIQUE on
  // (company_id, scope_type, scope_id, metric, window_kind).
  console.log("[seed-mira-labs-month1-finance] budget_policies…");

  const policyDefs = [
    { key: "maya" as const, scopeId: MAYA.id, amount: MAYA.budgetMonthlyCents },
    { key: "theo" as const, scopeId: THEO.id, amount: THEO.budgetMonthlyCents },
    { key: "iris" as const, scopeId: IRIS.id, amount: IRIS.budgetMonthlyCents },
  ];
  const policyIdByAgent = new Map<AgentKey, string>();
  for (const pd of policyDefs) {
    // Check existing.
    const existing = await tx
      .select({ id: budgetPolicies.id })
      .from(budgetPolicies)
      .where(
        sql`${budgetPolicies.companyId} = ${MIRA}::uuid AND ${budgetPolicies.scopeType} = 'agent' AND ${budgetPolicies.scopeId} = ${pd.scopeId}::uuid AND ${budgetPolicies.metric} = 'billed_cents' AND ${budgetPolicies.windowKind} = 'monthly'`,
      );
    if (existing.length > 0) {
      policyIdByAgent.set(pd.key, existing[0]!.id);
      continue;
    }
    const [row] = await tx
      .insert(budgetPolicies)
      .values({
        companyId: MIRA,
        scopeType: "agent",
        scopeId: pd.scopeId,
        metric: "billed_cents",
        windowKind: "monthly",
        amount: pd.amount,
        warnPercent: 80,
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
        createdByUserId: ANITA_AUTH_UID,
        updatedByUserId: ANITA_AUTH_UID,
      })
      .returning({ id: budgetPolicies.id });
    policyIdByAgent.set(pd.key, row!.id);
    summary.budgetPolicies++;
  }

  // ─── 3. budget_incidents (2) ──────────────────────────────────────────────
  // Per spec §3.24:
  //   1. Day 12 (Apr 24) Theo OpenAI spike — amountObserved 12500c (125% of
  //      $100), status='resolved', resolvedAt 4h later.
  //   2. Day 26 (May 8) Maya cumulative approaching limit — 13800c (92% of
  //      $150), status='open'.
  // UNIQUE partial on (policyId, windowStart, thresholdType) WHERE status <>
  // 'dismissed'. We use thresholdType='warn' for the open/approaching one,
  // and thresholdType='hard_stop' for the resolved overage to dodge the
  // unique constraint.
  console.log("[seed-mira-labs-month1-finance] budget_incidents…");

  const aprWindowStart = ist(2026, 4, 1, 0, 0);
  const aprWindowEnd = ist(2026, 4, 30, 23, 59, 59);
  const mayWindowStart = ist(2026, 5, 1, 0, 0);
  const mayWindowEnd = ist(2026, 5, 31, 23, 59, 59);

  const theoSpikeAt = ist(2026, 4, 24, 16, 12);
  const theoResolvedAt = addHours(theoSpikeAt, 4);
  const mayaApproachAt = ist(2026, 5, 8, 19, 5);

  const incidentsToInsert: Array<typeof budgetIncidents.$inferInsert> = [];

  const theoPolicyId = policyIdByAgent.get("theo")!;
  // Idempotency: check existing.
  const existingTheoInc = await tx
    .select({ id: budgetIncidents.id })
    .from(budgetIncidents)
    .where(
      sql`${budgetIncidents.companyId} = ${MIRA}::uuid AND ${budgetIncidents.policyId} = ${theoPolicyId}::uuid AND ${budgetIncidents.windowStart} = ${aprWindowStart.toISOString()}::timestamptz AND ${budgetIncidents.thresholdType} = 'hard_stop'`,
    );
  if (existingTheoInc.length === 0) {
    incidentsToInsert.push({
      companyId: MIRA,
      policyId: theoPolicyId,
      scopeType: "agent",
      scopeId: THEO.id,
      metric: "billed_cents",
      windowKind: "monthly",
      windowStart: aprWindowStart,
      windowEnd: aprWindowEnd,
      thresholdType: "hard_stop",
      amountLimit: THEO.budgetMonthlyCents, // 10000
      amountObserved: 12500,
      status: "resolved",
      approvalId: null,
      resolvedAt: theoResolvedAt,
      createdAt: theoSpikeAt,
      updatedAt: theoResolvedAt,
    });
  }

  const mayaPolicyId = policyIdByAgent.get("maya")!;
  const existingMayaInc = await tx
    .select({ id: budgetIncidents.id })
    .from(budgetIncidents)
    .where(
      sql`${budgetIncidents.companyId} = ${MIRA}::uuid AND ${budgetIncidents.policyId} = ${mayaPolicyId}::uuid AND ${budgetIncidents.windowStart} = ${mayWindowStart.toISOString()}::timestamptz AND ${budgetIncidents.thresholdType} = 'warn'`,
    );
  if (existingMayaInc.length === 0) {
    incidentsToInsert.push({
      companyId: MIRA,
      policyId: mayaPolicyId,
      scopeType: "agent",
      scopeId: MAYA.id,
      metric: "billed_cents",
      windowKind: "monthly",
      windowStart: mayWindowStart,
      windowEnd: mayWindowEnd,
      thresholdType: "warn",
      amountLimit: MAYA.budgetMonthlyCents, // 15000
      amountObserved: 13800,
      status: "open",
      approvalId: null,
      resolvedAt: null,
      createdAt: mayaApproachAt,
      updatedAt: mayaApproachAt,
    });
  }

  if (incidentsToInsert.length > 0) {
    await tx.insert(budgetIncidents).values(incidentsToInsert);
    summary.budgetIncidents = incidentsToInsert.length;
  }

  // ─── 4. marketing_spend (3) ───────────────────────────────────────────────
  console.log("[seed-mira-labs-month1-finance] marketing_spend…");

  const marketingPlans = [
    {
      channel: "linkedin",
      amountCents: 20000,
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      notes: "LinkedIn Premium for outbound research",
    },
    {
      channel: "partnerships",
      amountCents: 0,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      notes: "Northwood→SkyBridge intro",
    },
    {
      channel: "content",
      amountCents: 5000,
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      notes: "Buffer scheduling",
    },
  ];

  for (const mp of marketingPlans) {
    const existing = await tx
      .select({ id: marketingSpend.id })
      .from(marketingSpend)
      .where(
        sql`${marketingSpend.companyId} = ${MIRA}::uuid AND ${marketingSpend.channel} = ${mp.channel} AND ${marketingSpend.periodStart} = ${mp.periodStart}::date`,
      );
    if (existing.length > 0) continue;
    await tx.insert(marketingSpend).values({
      companyId: MIRA,
      channel: mp.channel,
      periodStart: mp.periodStart,
      periodEnd: mp.periodEnd,
      amountCents: mp.amountCents,
      currency: "USD",
      notes: mp.notes,
      createdBy: ANITA_AUTH_UID,
    });
    summary.marketingSpend++;
  }

  // ─── 5. finance_events (30) ───────────────────────────────────────────────
  // Idempotency: a representative-shape "occurredAt + eventKind + biller +
  // amountCents" composite. We use synthetic externalInvoiceId / metadata
  // tagging for richer narrative.
  console.log("[seed-mira-labs-month1-finance] finance_events…");

  const existingFinanceCount = await tx
    .select({ id: financeEvents.id })
    .from(financeEvents)
    .where(eq(financeEvents.companyId, MIRA));
  if (existingFinanceCount.length >= 30) {
    console.log(
      `[seed-mira-labs-month1-finance] finance_events already at target (${existingFinanceCount.length}). Skipping.`,
    );
  } else {
    // 8 revenue (credit): 4 clients × 2 months minus Bake House May (failed).
    // Northwood $1,800; Bake House $1,200 (Apr only); Clearview $2,400;
    // Shore Capital $1,000 (May only — signed Apr 22, first charge May 1).
    const revenueRows: Array<typeof financeEvents.$inferInsert> = [
      // April
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 180000,
        currency: "USD",
        externalInvoiceId: "in_northwood_apr_001",
        description: "Northwood Dental — April retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Northwood Dental", month: "2026-04" },
        occurredAt: ist(2026, 4, 1, 9, 12),
      },
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 120000,
        currency: "USD",
        externalInvoiceId: "in_bakehouse_apr_002",
        description: "Bake House — April retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Bake House", month: "2026-04" },
        occurredAt: ist(2026, 4, 1, 9, 18),
      },
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 240000,
        currency: "USD",
        externalInvoiceId: "in_clearview_apr_003",
        description: "Clearview Legal — April retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Clearview Legal", month: "2026-04" },
        occurredAt: ist(2026, 4, 1, 9, 25),
      },
      // May
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 180000,
        currency: "USD",
        externalInvoiceId: "in_northwood_may_004",
        description: "Northwood Dental — May retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Northwood Dental", month: "2026-05" },
        occurredAt: ist(2026, 5, 1, 9, 11),
      },
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 240000,
        currency: "USD",
        externalInvoiceId: "in_clearview_may_005",
        description: "Clearview Legal — May retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Clearview Legal", month: "2026-05" },
        occurredAt: ist(2026, 5, 1, 9, 23),
      },
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 100000,
        currency: "USD",
        externalInvoiceId: "in_shorecapital_may_006",
        description: "Shore Capital — first month retainer",
        metadataJson: { persona: PERSONA_TAG, client: "Shore Capital", month: "2026-05" },
        occurredAt: ist(2026, 5, 1, 9, 31),
      },
      // Two more revenue events: setup fees collected at signing.
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 300000,
        currency: "USD",
        externalInvoiceId: "in_shorecapital_setup_007",
        description: "Shore Capital — setup fee",
        metadataJson: { persona: PERSONA_TAG, client: "Shore Capital", kind: "setup_fee" },
        occurredAt: ist(2026, 4, 23, 17, 4),
      },
      {
        companyId: MIRA,
        eventKind: "revenue",
        direction: "credit",
        biller: "stripe",
        provider: "stripe",
        amountCents: 60000,
        currency: "USD",
        externalInvoiceId: "in_clearview_addon_008",
        description: "Clearview Legal — Q2 scope-expansion add-on (one-time)",
        metadataJson: { persona: PERSONA_TAG, client: "Clearview Legal", kind: "scope_addon" },
        occurredAt: ist(2026, 4, 19, 11, 32),
      },
    ];

    // 12 agent_cost (debit): weekly per-agent aggregated. Approx values
    // Maya/Theo/Iris weekly costs derived from arc:
    //   Maya: ~$1.50/wk = 150c → 30c +
    //   Theo: ~$0.50/wk = 50c
    //   Iris: ~$0.40/wk = 40c
    // We build 4 weeks × 3 agents = 12.
    const agentCostRows: Array<typeof financeEvents.$inferInsert> = [];
    const weekStarts = [
      ist(2026, 4, 13, 0, 0), // week 1
      ist(2026, 4, 20, 0, 0), // week 2
      ist(2026, 4, 27, 0, 0), // week 3
      ist(2026, 5, 4, 0, 0), // week 4
    ];
    const weekEnds = [
      ist(2026, 4, 19, 23, 59),
      ist(2026, 4, 26, 23, 59),
      ist(2026, 5, 3, 23, 59),
      ist(2026, 5, 10, 23, 59),
    ];
    // approximate per-week amounts; sum must roughly track per-agent totals.
    const perWeek: Record<AgentKey, number[]> = {
      maya: [80, 110, 130, 130], // sum ~450c
      theo: [25, 55, 50, 50], // sum ~180c
      iris: [30, 35, 40, 35], // sum ~140c
    };
    const agentMap: Record<AgentKey, string> = {
      maya: MAYA.id,
      theo: THEO.id,
      iris: IRIS.id,
    };

    for (const k of ["maya", "theo", "iris"] as const) {
      for (let w = 0; w < 4; w++) {
        const occurredAt = clampToRunNow(weekEnds[w]!);
        agentCostRows.push({
          companyId: MIRA,
          agentId: agentMap[k],
          eventKind: "agent_cost",
          direction: "debit",
          biller: providerForAgent(k),
          provider: providerForAgent(k),
          model: modelForAgent(k),
          executionAdapterType: k === "theo" ? "openai_api" : "anthropic_api",
          amountCents: perWeek[k][w]!,
          currency: "USD",
          estimated: false,
          description: `${k[0]!.toUpperCase() + k.slice(1)} — week ${w + 1} LLM API spend`,
          metadataJson: {
            persona: PERSONA_TAG,
            week: w + 1,
            agent: k,
          },
          occurredAt,
        });
      }
    }

    // 6 tooling_cost (debit): Composio $20/mo × 2 months (Apr/May invoices
    // prorated) + FounderOS $50/mo × 2 months + 2 misc.
    const toolingRows: Array<typeof financeEvents.$inferInsert> = [
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "composio",
        amountCents: 2000,
        currency: "USD",
        estimated: true,
        description: "Composio — April subscription",
        metadataJson: { persona: PERSONA_TAG, tool: "composio", month: "2026-04" },
        occurredAt: ist(2026, 4, 13, 11, 12),
      },
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "composio",
        amountCents: 2000,
        currency: "USD",
        estimated: true,
        description: "Composio — May subscription",
        metadataJson: { persona: PERSONA_TAG, tool: "composio", month: "2026-05" },
        occurredAt: ist(2026, 5, 13, 11, 12),
      },
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "founderos",
        amountCents: 5000,
        currency: "USD",
        estimated: true,
        description: "FounderOS subscription — April",
        metadataJson: { persona: PERSONA_TAG, tool: "founderos", month: "2026-04" },
        occurredAt: ist(2026, 4, 13, 0, 0),
      },
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "founderos",
        amountCents: 5000,
        currency: "USD",
        estimated: true,
        description: "FounderOS subscription — May",
        metadataJson: { persona: PERSONA_TAG, tool: "founderos", month: "2026-05" },
        occurredAt: ist(2026, 5, 13, 0, 0),
      },
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "stripe",
        amountCents: 1200,
        currency: "USD",
        estimated: false,
        description: "Stripe processing fees — April",
        metadataJson: { persona: PERSONA_TAG, tool: "stripe", month: "2026-04" },
        occurredAt: ist(2026, 5, 1, 0, 5),
      },
      {
        companyId: MIRA,
        eventKind: "tooling_cost",
        direction: "debit",
        biller: "aws",
        amountCents: 800,
        currency: "USD",
        estimated: true,
        description: "AWS — light hosting / scratch storage",
        metadataJson: { persona: PERSONA_TAG, tool: "aws" },
        occurredAt: ist(2026, 5, 5, 9, 0),
      },
    ];

    // 4 operating_cost (debit): domain renewal, Anita's salary placeholder,
    // misc one-offs.
    const operatingRows: Array<typeof financeEvents.$inferInsert> = [
      {
        companyId: MIRA,
        eventKind: "operating_cost",
        direction: "debit",
        biller: "namecheap",
        amountCents: 1200,
        currency: "USD",
        estimated: false,
        description: "Domain renewal — miralabs.in",
        metadataJson: { persona: PERSONA_TAG, kind: "domain" },
        occurredAt: ist(2026, 4, 20, 14, 18),
      },
      {
        companyId: MIRA,
        eventKind: "operating_cost",
        direction: "debit",
        biller: "google",
        amountCents: 1800,
        currency: "USD",
        estimated: false,
        description: "Google Workspace — April",
        metadataJson: { persona: PERSONA_TAG, kind: "saas" },
        occurredAt: ist(2026, 4, 25, 10, 0),
      },
      {
        companyId: MIRA,
        eventKind: "operating_cost",
        direction: "debit",
        biller: "google",
        amountCents: 1800,
        currency: "USD",
        estimated: false,
        description: "Google Workspace — May",
        metadataJson: { persona: PERSONA_TAG, kind: "saas" },
        occurredAt: ist(2026, 5, 12, 10, 0),
      },
      {
        companyId: MIRA,
        eventKind: "operating_cost",
        direction: "debit",
        biller: "vendor",
        amountCents: 4000,
        currency: "USD",
        estimated: true,
        description: "Bangalore co-working day passes",
        metadataJson: { persona: PERSONA_TAG, kind: "coworking" },
        occurredAt: ist(2026, 4, 30, 19, 30),
      },
    ];

    const allFinanceRows = [...revenueRows, ...agentCostRows, ...toolingRows, ...operatingRows];
    const CHUNK_FE = 30;
    for (let i = 0; i < allFinanceRows.length; i += CHUNK_FE) {
      await tx.insert(financeEvents).values(allFinanceRows.slice(i, i + CHUNK_FE));
    }
    summary.financeEvents = allFinanceRows.length;
  }

  // ─── 6. events (80) ───────────────────────────────────────────────────────
  // CHECK: source IN ('stripe','posthog','linkedin','notion','slack','hubspot').
  // UNIQUE: (company_id, source, dedup_key). dedupKey NOT NULL.
  console.log("[seed-mira-labs-month1-finance] events…");

  // Synthesize keys per spec §3.20.
  const hex = (n: number) =>
    Math.floor(n).toString(16).padStart(8, "0").slice(-8);

  const eventRows: Array<typeof events.$inferInsert> = [];

  // STRIPE: 25 events.
  //   4 invoice.created × 2 months (Apr 1, May 1) — minus Bake House May
  //     ⇒ Apr: 4 (Northwood, Bake House, Clearview, Shore Cap N/A — Shore not yet),
  //     ⇒ May: 4 (Northwood, Bake House, Clearview, Shore Capital)
  //     ⇒ Total 8 invoice.created. We label them "invoice.created" for both
  //       months including the prospective Shore Capital April that didn't
  //       happen — actually spec says 4 + 4 minus Bake House May. We honor:
  //       4 Apr (Northwood, BH, Clearview, Shore-skipped) + 4 May (all 4 + BH).
  //       Easier: 4 invoice.created in Apr (NH, BH, CV, SC=skipped since SC
  //       signed Apr 22) + 4 in May (NH, BH, CV, SC). Total = 8 invoice.created.
  //   4 invoice.paid + 1 invoice.payment_failed (Bake House May 7) = 5.
  //   5 customer.subscription.updated.
  //   1 customer.created (Shore Capital, Apr 22).
  //   ~10 charge.succeeded — fills remaining: 25 - 8 - 5 - 5 - 1 = 6, but
  //   spec says ~10 so distribute around. We'll plan 6 charge.succeeded to
  //   keep total at exactly 25.

  let stripeSeed = 0xa1b2c3;
  const evtId = () => `evt_${hex(stripeSeed++)}`;

  // Apr invoice.created — 4 (we include Shore Capital even if it didn't bill
  // for the month for narrative shape).
  const aprInvoices = [
    { customer: "cus_northwood", inv: "in_northwood_apr_001", amount: 180000, client: "Northwood Dental" },
    { customer: "cus_bakehouse", inv: "in_bakehouse_apr_002", amount: 120000, client: "Bake House" },
    { customer: "cus_clearview", inv: "in_clearview_apr_003", amount: 240000, client: "Clearview Legal" },
    { customer: "cus_shorecapital", inv: "in_shorecapital_apr_setup", amount: 300000, client: "Shore Capital (setup)" },
  ];
  for (const inv of aprInvoices) {
    eventRows.push({
      companyId: MIRA,
      source: "stripe",
      entityType: "invoice",
      eventName: "invoice.created",
      dedupKey: evtId(),
      occurredAt: ist(2026, 4, 1, 9, 0),
      payload: {
        id: evtId(),
        type: "invoice.created",
        data: {
          object: { id: inv.inv, customer: inv.customer, amount_due: inv.amount, currency: "usd" },
        },
        persona: PERSONA_TAG,
        client: inv.client,
      } as Record<string, unknown>,
    });
  }
  const mayInvoices = [
    { customer: "cus_northwood", inv: "in_northwood_may_004", amount: 180000, client: "Northwood Dental" },
    { customer: "cus_bakehouse", inv: "in_bakehouse_may_005", amount: 120000, client: "Bake House" },
    { customer: "cus_clearview", inv: "in_clearview_may_006", amount: 240000, client: "Clearview Legal" },
    { customer: "cus_shorecapital", inv: "in_shorecapital_may_007", amount: 100000, client: "Shore Capital" },
  ];
  for (const inv of mayInvoices) {
    eventRows.push({
      companyId: MIRA,
      source: "stripe",
      entityType: "invoice",
      eventName: "invoice.created",
      dedupKey: evtId(),
      occurredAt: ist(2026, 5, 1, 9, 0),
      payload: {
        id: evtId(),
        type: "invoice.created",
        data: {
          object: { id: inv.inv, customer: inv.customer, amount_due: inv.amount, currency: "usd" },
        },
        persona: PERSONA_TAG,
        client: inv.client,
      } as Record<string, unknown>,
    });
  }

  // 4 invoice.paid + 1 invoice.payment_failed (Bake House May 7).
  const paidInvoices = [
    { customer: "cus_northwood", inv: "in_northwood_may_004", amount: 180000, when: ist(2026, 5, 2, 14, 30), client: "Northwood Dental" },
    { customer: "cus_clearview", inv: "in_clearview_may_006", amount: 240000, when: ist(2026, 5, 2, 16, 8), client: "Clearview Legal" },
    { customer: "cus_shorecapital", inv: "in_shorecapital_may_007", amount: 100000, when: ist(2026, 5, 3, 11, 22), client: "Shore Capital" },
    { customer: "cus_bakehouse", inv: "in_bakehouse_apr_002", amount: 120000, when: ist(2026, 4, 3, 10, 4), client: "Bake House" },
  ];
  for (const p of paidInvoices) {
    eventRows.push({
      companyId: MIRA,
      source: "stripe",
      entityType: "invoice",
      eventName: "invoice.paid",
      dedupKey: evtId(),
      occurredAt: p.when,
      payload: {
        id: evtId(),
        type: "invoice.paid",
        data: { object: { id: p.inv, customer: p.customer, amount_paid: p.amount } },
        persona: PERSONA_TAG,
        client: p.client,
      } as Record<string, unknown>,
    });
  }
  eventRows.push({
    companyId: MIRA,
    source: "stripe",
    entityType: "invoice",
    eventName: "invoice.payment_failed",
    dedupKey: evtId(),
    occurredAt: ist(2026, 5, 7, 14, 22),
    payload: {
      id: evtId(),
      type: "invoice.payment_failed",
      data: {
        object: { id: "in_bakehouse_may_005", customer: "cus_bakehouse", amount_due: 120000, attempt_count: 1, next_payment_attempt: null },
      },
      persona: PERSONA_TAG,
      client: "Bake House",
    } as Record<string, unknown>,
  });

  // 5 customer.subscription.updated.
  const subUpdates = [
    { customer: "cus_shorecapital", when: ist(2026, 4, 23, 17, 10), reason: "subscription_activated" },
    { customer: "cus_clearview", when: ist(2026, 4, 19, 11, 35), reason: "scope_expansion_addon" },
    { customer: "cus_northwood", when: ist(2026, 5, 5, 9, 30), reason: "billing_anchor_updated" },
    { customer: "cus_bakehouse", when: ist(2026, 5, 7, 14, 25), reason: "past_due" },
    { customer: "cus_clearview", when: ist(2026, 5, 11, 18, 0), reason: "metadata_updated" },
  ];
  for (const s of subUpdates) {
    eventRows.push({
      companyId: MIRA,
      source: "stripe",
      entityType: "subscription",
      eventName: "customer.subscription.updated",
      dedupKey: evtId(),
      occurredAt: s.when,
      payload: {
        id: evtId(),
        type: "customer.subscription.updated",
        data: { object: { id: "sub_" + hex(stripeSeed++), customer: s.customer, status: "active" } },
        persona: PERSONA_TAG,
        reason: s.reason,
      } as Record<string, unknown>,
    });
  }

  // 1 customer.created (Shore Capital, Apr 22).
  eventRows.push({
    companyId: MIRA,
    source: "stripe",
    entityType: "customer",
    eventName: "customer.created",
    dedupKey: evtId(),
    occurredAt: ist(2026, 4, 22, 16, 45),
    payload: {
      id: evtId(),
      type: "customer.created",
      data: { object: { id: "cus_shorecapital", email: "rahul@shorecapital.in", name: "Shore Capital Advisors" } },
      persona: PERSONA_TAG,
    } as Record<string, unknown>,
  });

  // 6 charge.succeeded — bring stripe count to 25.
  const charges = [
    { customer: "cus_northwood", amount: 180000, when: ist(2026, 4, 2, 14, 32), inv: "in_northwood_apr_001" },
    { customer: "cus_clearview", amount: 240000, when: ist(2026, 4, 2, 14, 35), inv: "in_clearview_apr_003" },
    { customer: "cus_shorecapital", amount: 300000, when: ist(2026, 4, 23, 17, 5), inv: "in_shorecapital_apr_setup" },
    { customer: "cus_northwood", amount: 180000, when: ist(2026, 5, 2, 14, 31), inv: "in_northwood_may_004" },
    { customer: "cus_clearview", amount: 240000, when: ist(2026, 5, 2, 16, 9), inv: "in_clearview_may_006" },
    { customer: "cus_shorecapital", amount: 100000, when: ist(2026, 5, 3, 11, 23), inv: "in_shorecapital_may_007" },
  ];
  for (const ch of charges) {
    eventRows.push({
      companyId: MIRA,
      source: "stripe",
      entityType: "charge",
      eventName: "charge.succeeded",
      dedupKey: evtId(),
      occurredAt: ch.when,
      payload: {
        id: evtId(),
        type: "charge.succeeded",
        data: { object: { id: "ch_" + hex(stripeSeed++), customer: ch.customer, amount: ch.amount, invoice: ch.inv } },
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }

  // SLACK: 35 events — message_posted on #mira-team / #pipeline / #mira-finance.
  // dedupKey shape: `${channel}:${ts}:${user}`.
  const slackChannels: Array<{ channel: string; channelId: string }> = [
    { channel: "mira-team", channelId: "C0MIRATEAM" },
    { channel: "pipeline", channelId: "C0PIPELINE" },
    { channel: "mira-finance", channelId: "C0MIRAFIN" },
  ];

  // 25 messages on #mira-team (Maya morning standups), 5 on #pipeline (Theo
  // posts), 5 on #mira-finance (Iris Friday digest).
  // Pin to weekdays in the window. Morning posts ~07:35 IST.
  const dayStart = ist(2026, 4, 13, 0, 0);
  function istWeekday(d: Date): number {
    const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
    return shifted.getUTCDay();
  }
  // 25 mira-team morning posts (weekdays only).
  let teamPosts = 0;
  for (let dayIdx = 0; dayIdx <= 30 && teamPosts < 25; dayIdx++) {
    const day = new Date(dayStart.getTime() + dayIdx * 86_400_000);
    const wd = istWeekday(day);
    if (wd === 0 || wd === 6) continue;
    const when = new Date(day.getTime() + (7 * 60 + 35) * 60_000 + (dayIdx % 17) * 60_000);
    if (when.getTime() > RUN_NOW.getTime()) continue;
    const ts = Math.floor(when.getTime() / 1000) + "." + String((dayIdx * 13) % 999999).padStart(6, "0");
    const userId = "U_MAYA";
    eventRows.push({
      companyId: MIRA,
      source: "slack",
      entityType: "message",
      eventName: "message_posted",
      dedupKey: `${slackChannels[0]!.channelId}:${ts}:${userId}`,
      occurredAt: when,
      payload: {
        channel: slackChannels[0]!.channel,
        channel_id: slackChannels[0]!.channelId,
        ts,
        user: userId,
        text: `[Maya] Daily brief posted · ${(dayIdx % 4) + 1} action(s) for review.`,
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
    teamPosts++;
  }
  // 2 additional Maya mira-team evening recaps (to hit 25 weekday-mornings is
  // structurally impossible: the 30-day window contains only 23 weekdays.
  // Spec says "Maya's morning standups, ~25" — we backfill 2 evening recaps
  // on heavy days so the total mira-team Maya posts lands at the spec target.
  const extraTeamPosts = [
    { when: ist(2026, 4, 21, 19, 30), text: "[Maya] Evening recap — Shore Capital proposal sent. Pipeline +1." },
    { when: ist(2026, 4, 30, 19, 0), text: "[Maya] Evening recap — Pivot committed. Theo prompt swapped. Verdant cancelled." },
  ];
  for (let i = 0; i < extraTeamPosts.length; i++) {
    const p = extraTeamPosts[i]!;
    const ts = Math.floor(p.when.getTime() / 1000) + "." + String(900000 + i).padStart(6, "0");
    eventRows.push({
      companyId: MIRA,
      source: "slack",
      entityType: "message",
      eventName: "message_posted",
      dedupKey: `${slackChannels[0]!.channelId}:${ts}:U_MAYA`,
      occurredAt: p.when,
      payload: {
        channel: slackChannels[0]!.channel,
        channel_id: slackChannels[0]!.channelId,
        ts,
        user: "U_MAYA",
        text: p.text,
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }

  // 5 pipeline channel posts (Theo).
  const pipelinePosts = [
    { when: ist(2026, 4, 20, 11, 5), text: "[Theo] Shore Capital proposal drafted — 412 words. Approval queued." },
    { when: ist(2026, 4, 21, 10, 2), text: "[Theo] Shore Capital proposal sent. Awaiting reply." },
    { when: ist(2026, 5, 4, 14, 18), text: "[Theo] SkyBridge Insurance cold outreach drafted. Pro-services template." },
    { when: ist(2026, 5, 8, 19, 12), text: "[Theo] Acme Retail proposal v1 ready for your review." },
    { when: ist(2026, 5, 12, 21, 30), text: "[Theo] Acme Retail proposal v2 incorporating your edits. Final draft." },
  ];
  for (let i = 0; i < pipelinePosts.length; i++) {
    const p = pipelinePosts[i]!;
    const ts = Math.floor(p.when.getTime() / 1000) + "." + String((i * 17) % 999999).padStart(6, "0");
    eventRows.push({
      companyId: MIRA,
      source: "slack",
      entityType: "message",
      eventName: "message_posted",
      dedupKey: `${slackChannels[1]!.channelId}:${ts}:U_THEO`,
      occurredAt: p.when,
      payload: {
        channel: slackChannels[1]!.channel,
        channel_id: slackChannels[1]!.channelId,
        ts,
        user: "U_THEO",
        text: p.text,
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }
  // 5 mira-finance channel posts (Iris).
  const financePosts = [
    { when: ist(2026, 4, 17, 17, 4), text: "[Iris] Friday finance digest — MRR $5,200; 0 overdue." },
    { when: ist(2026, 4, 24, 17, 5), text: "[Iris] Friday finance digest — MRR $5,200; 1 retainer summary pending." },
    { when: ist(2026, 5, 1, 17, 7), text: "[Iris] Friday finance digest — MRR $6,400 (Shore Capital activated). 0 overdue." },
    { when: ist(2026, 5, 7, 14, 32), text: "[Iris] Alert — Bake House invoice payment failed. Auto-retry scheduled." },
    { when: ist(2026, 5, 8, 17, 6), text: "[Iris] Friday finance digest — MRR $6,400; 1 invoice past due (Bake House)." },
  ];
  for (let i = 0; i < financePosts.length; i++) {
    const p = financePosts[i]!;
    const ts = Math.floor(p.when.getTime() / 1000) + "." + String((i * 23) % 999999).padStart(6, "0");
    eventRows.push({
      companyId: MIRA,
      source: "slack",
      entityType: "message",
      eventName: "message_posted",
      dedupKey: `${slackChannels[2]!.channelId}:${ts}:U_IRIS`,
      occurredAt: p.when,
      payload: {
        channel: slackChannels[2]!.channel,
        channel_id: slackChannels[2]!.channelId,
        ts,
        user: "U_IRIS",
        text: p.text,
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }

  // LINKEDIN: 8 — 3 connection_request_accepted + 5 message_received from Day 22+.
  const linkedinEvents = [
    { ev: "connection_request_accepted", when: ist(2026, 5, 4, 11, 12), who: "skybridge_ceo" },
    { ev: "connection_request_accepted", when: ist(2026, 5, 5, 9, 18), who: "fielding_ops" },
    { ev: "connection_request_accepted", when: ist(2026, 5, 6, 14, 0), who: "acme_coo" },
    { ev: "message_received", when: ist(2026, 5, 5, 18, 4), who: "skybridge_ceo", txt: "Interested — when are you free?" },
    { ev: "message_received", when: ist(2026, 5, 7, 11, 22), who: "fielding_ops", txt: "Let's chat next Wed." },
    { ev: "message_received", when: ist(2026, 5, 8, 9, 32), who: "acme_coo", txt: "Proposal looks great. Let me share with my team." },
    { ev: "message_received", when: ist(2026, 5, 10, 14, 0), who: "skybridge_ceo", txt: "Forwarded to our broker leads." },
    { ev: "message_received", when: ist(2026, 5, 12, 16, 18), who: "fielding_ops", txt: "Confirmed call May 14 11am IST." },
  ];
  for (let i = 0; i < linkedinEvents.length; i++) {
    const e = linkedinEvents[i]!;
    const liId = `li_${hex(0x9000 + i)}`;
    eventRows.push({
      companyId: MIRA,
      source: "linkedin",
      entityType: "interaction",
      eventName: e.ev,
      dedupKey: liId,
      occurredAt: e.when,
      payload: {
        id: liId,
        from: e.who,
        text: "txt" in e ? e.txt : undefined,
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }

  // POSTHOG: 12 — page_view on /agents, /inbox, /goals (Anita's UI dogfood).
  const pages = ["/agents", "/inbox", "/goals", "/finance", "/agents", "/inbox", "/issues", "/goals", "/inbox", "/agents", "/inbox", "/agents"];
  const distinctId = "ph_anita_mehra";
  for (let i = 0; i < 12; i++) {
    const day = 23 + (i % 7); // distribute across early-May
    const when = ist(2026, day <= 30 ? 4 : 5, day <= 30 ? day : day - 30, 8 + ((i * 3) % 12), (i * 7) % 60);
    const eventName = "page_view";
    const ts = Math.floor(when.getTime() / 1000);
    const dedup = `synth:${eventName}:${ts}:${distinctId}:${i}`;
    eventRows.push({
      companyId: MIRA,
      source: "posthog",
      entityType: "page_view",
      eventName,
      dedupKey: dedup,
      occurredAt: when,
      payload: {
        event: eventName,
        distinct_id: distinctId,
        properties: { $current_url: pages[i % pages.length], $browser: "Chrome", $referrer: "direct" },
        persona: PERSONA_TAG,
      } as Record<string, unknown>,
    });
  }

  // Trim to exactly 80 (sanity).
  const eventRowsTrim = eventRows.slice(0, 80);
  // Insert with onConflictDoNothing on (companyId, source, dedupKey).
  const EVT_CHUNK = 40;
  let evInserted = 0;
  for (let i = 0; i < eventRowsTrim.length; i += EVT_CHUNK) {
    const slice = eventRowsTrim.slice(i, i + EVT_CHUNK);
    const ret = await tx
      .insert(events)
      .values(slice)
      .onConflictDoNothing({ target: [events.companyId, events.source, events.dedupKey] })
      .returning({ id: events.id });
    evInserted += ret.length;
  }
  summary.events = evInserted;

  // ─── 7. workflows + workflow_runs (OPTIONAL) ──────────────────────────────
  console.log("[seed-mira-labs-month1-finance] workflows + workflow_runs…");

  const workflowDefs = [
    {
      name: "Welcome retainer email",
      template: "onboarding-emails" as const,
      triggerKind: "event" as const,
      triggerSpec: { source: "stripe", event: "customer.subscription.created" },
      autonomyLevel: 2,
      status: "active" as const,
    },
    {
      name: "Monthly retainer-renewal nudge",
      template: "churn-rescue" as const,
      triggerKind: "schedule" as const,
      triggerSpec: { cron: "0 10 1 * *", timezone: "Asia/Kolkata" },
      autonomyLevel: 3,
      status: "active" as const,
    },
  ];

  const workflowIdByName = new Map<string, string>();
  for (const wf of workflowDefs) {
    const existing = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(sql`${workflows.companyId} = ${MIRA}::uuid AND ${workflows.name} = ${wf.name}`);
    if (existing.length > 0) {
      workflowIdByName.set(wf.name, existing[0]!.id);
      continue;
    }
    const [row] = await tx
      .insert(workflows)
      .values({
        companyId: MIRA,
        name: wf.name,
        template: wf.template,
        triggerKind: wf.triggerKind,
        triggerSpec: wf.triggerSpec,
        autonomyLevel: wf.autonomyLevel,
        status: wf.status,
        config: { persona: PERSONA_TAG },
      })
      .returning({ id: workflows.id });
    workflowIdByName.set(wf.name, row!.id);
    summary.workflows++;
  }

  // workflow_runs (6 total):
  //   1 run: Shore Capital welcome (welcome retainer email)
  //   4 runs: monthly renewal nudge (one per client, May 1)
  //   1 failed: Bake House renewal nudge (post overdue)
  const welcomeId = workflowIdByName.get("Welcome retainer email")!;
  const renewalId = workflowIdByName.get("Monthly retainer-renewal nudge")!;

  const wfRunDefs: Array<{
    workflowId: string;
    status: "completed" | "failed";
    triggeredBy: Record<string, unknown>;
    metricSnapshot: Record<string, unknown>;
    idempotencyKey: string;
    createdAt: Date;
    completedAt: Date | null;
  }> = [
    {
      workflowId: welcomeId,
      status: "completed",
      triggeredBy: { kind: "event", eventName: "customer.subscription.created", customer: "Shore Capital" },
      metricSnapshot: { mrrCents: 580000, customersSigned: 4, persona: PERSONA_TAG },
      idempotencyKey: "shore-welcome-2026-04-23",
      createdAt: ist(2026, 4, 23, 17, 12),
      completedAt: ist(2026, 4, 23, 17, 14),
    },
    {
      workflowId: renewalId,
      status: "completed",
      triggeredBy: { kind: "schedule", cron: "0 10 1 * *", client: "Northwood Dental" },
      metricSnapshot: { client: "Northwood Dental", mrrCents: 180000, persona: PERSONA_TAG },
      idempotencyKey: "renewal-northwood-2026-05-01",
      createdAt: ist(2026, 5, 1, 10, 1),
      completedAt: ist(2026, 5, 1, 10, 3),
    },
    {
      workflowId: renewalId,
      status: "completed",
      triggeredBy: { kind: "schedule", cron: "0 10 1 * *", client: "Clearview Legal" },
      metricSnapshot: { client: "Clearview Legal", mrrCents: 240000, persona: PERSONA_TAG },
      idempotencyKey: "renewal-clearview-2026-05-01",
      createdAt: ist(2026, 5, 1, 10, 2),
      completedAt: ist(2026, 5, 1, 10, 4),
    },
    {
      workflowId: renewalId,
      status: "completed",
      triggeredBy: { kind: "schedule", cron: "0 10 1 * *", client: "Shore Capital" },
      metricSnapshot: { client: "Shore Capital", mrrCents: 100000, persona: PERSONA_TAG },
      idempotencyKey: "renewal-shorecapital-2026-05-01",
      createdAt: ist(2026, 5, 1, 10, 3),
      completedAt: ist(2026, 5, 1, 10, 5),
    },
    {
      workflowId: renewalId,
      status: "completed",
      triggeredBy: { kind: "schedule", cron: "0 10 1 * *", client: "Bake House (initial)" },
      metricSnapshot: { client: "Bake House", mrrCents: 120000, persona: PERSONA_TAG },
      idempotencyKey: "renewal-bakehouse-2026-05-01",
      createdAt: ist(2026, 5, 1, 10, 4),
      completedAt: ist(2026, 5, 1, 10, 6),
    },
    {
      workflowId: renewalId,
      status: "failed",
      triggeredBy: { kind: "schedule", cron: "0 10 1 * *", client: "Bake House (overdue retry)" },
      metricSnapshot: {
        client: "Bake House",
        error: "invoice.payment_failed; auto-retry exhausted",
        persona: PERSONA_TAG,
      },
      idempotencyKey: "renewal-bakehouse-2026-05-07-overdue",
      createdAt: ist(2026, 5, 7, 14, 28),
      completedAt: ist(2026, 5, 7, 14, 30),
    },
  ];

  for (const wr of wfRunDefs) {
    // Idempotency: (companyId, workflowId, idempotencyKey).
    const existing = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        sql`${workflowRuns.companyId} = ${MIRA}::uuid AND ${workflowRuns.workflowId} = ${wr.workflowId}::uuid AND ${workflowRuns.idempotencyKey} = ${wr.idempotencyKey}`,
      );
    if (existing.length > 0) continue;
    await tx.insert(workflowRuns).values({
      companyId: MIRA,
      workflowId: wr.workflowId,
      status: wr.status,
      triggeredBy: wr.triggeredBy as { kind: "event" | "schedule" | "manual"; [key: string]: unknown },
      actions: [],
      metricSnapshot: wr.metricSnapshot,
      idempotencyKey: wr.idempotencyKey,
      createdAt: wr.createdAt,
      completedAt: wr.completedAt,
    });
    summary.workflowRuns++;
  }

  // ─── 8. activity_log (non-run state transitions) ──────────────────────────
  // Wave 1 already wrote ~80 run-related rows + 5 integration. We add:
  //   - 1 agent_config.revised (Theo Day 18 prompt swap)
  //   - ~15 issue.status_changed (representative — Wave B doesn't touch
  //     activity_log; these reflect status flips on the 30 new issues)
  //   - ~10 workflow.completed entries to match the workflow_runs above
  //   - 1 budget.incident.opened / .resolved
  // We tag entityType / entityId by reference rather than try to lookup
  // every new issue's UUID (Wave B owns those rows; we don't have the IDs
  // yet on this fresh-DB worktree). Use the issue identifier string as
  // entityId — it's a stable human-friendly key.
  console.log("[seed-mira-labs-month1-finance] activity_log (non-run delta)…");

  const activityRows: Array<typeof activityLog.$inferInsert> = [];

  // agent_config.revised (Theo Day 18 swap). Idempotency: check by action +
  // entityId.
  {
    const existingCfg = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        sql`${activityLog.companyId} = ${MIRA}::uuid AND ${activityLog.action} = 'agent_config.revised' AND ${activityLog.entityId} = ${THEO.id}`,
      );
    if (existingCfg.length === 0) {
      activityRows.push({
        companyId: MIRA,
        actorType: "user",
        actorId: ANITA_AUTH_UID,
        action: "agent_config.revised",
        entityType: "agent",
        entityId: THEO.id,
        agentId: THEO.id,
        details: {
          revision: 1,
          changedKeys: ["promptTemplate"],
          reason: "Pivoting wedge to professional services",
          persona: PERSONA_TAG,
        },
        createdAt: ist(2026, 4, 30, 14, 22),
      });
    }
  }

  // 15 issue.status_changed entries — by MIR identifier (Wave B's domain).
  const issueStatusChanges = [
    { mir: "MIR-006", from: "todo", to: "done", at: ist(2026, 4, 13, 11, 30), actor: "user" as const },
    { mir: "MIR-007", from: "in_progress", to: "done", at: ist(2026, 4, 14, 18, 30), actor: "agent" as const, agent: IRIS.id },
    { mir: "MIR-008", from: "in_progress", to: "done", at: ist(2026, 4, 15, 9, 32), actor: "agent" as const, agent: IRIS.id },
    { mir: "MIR-009", from: "in_progress", to: "done", at: ist(2026, 4, 15, 9, 40), actor: "agent" as const, agent: IRIS.id },
    { mir: "MIR-010", from: "in_progress", to: "done", at: ist(2026, 4, 15, 9, 48), actor: "agent" as const, agent: IRIS.id },
    { mir: "MIR-012", from: "in_progress", to: "done", at: ist(2026, 4, 20, 12, 0), actor: "agent" as const, agent: THEO.id },
    { mir: "MIR-013", from: "in_progress", to: "done", at: ist(2026, 4, 21, 10, 15), actor: "user" as const },
    { mir: "MIR-014", from: "in_progress", to: "done", at: ist(2026, 4, 23, 17, 10), actor: "user" as const },
    { mir: "MIR-015", from: "in_progress", to: "cancelled", at: ist(2026, 4, 30, 14, 25), actor: "user" as const },
    { mir: "MIR-019", from: "in_progress", to: "done", at: ist(2026, 4, 29, 22, 12), actor: "user" as const },
    { mir: "MIR-020", from: "todo", to: "done", at: ist(2026, 4, 30, 14, 24), actor: "user" as const },
    { mir: "MIR-026", from: "todo", to: "blocked", at: ist(2026, 5, 5, 11, 22), actor: "agent" as const, agent: MAYA.id },
    { mir: "MIR-028", from: "in_progress", to: "in_review", at: ist(2026, 5, 8, 19, 30), actor: "agent" as const, agent: THEO.id },
    { mir: "MIR-032", from: "todo", to: "done", at: ist(2026, 5, 11, 16, 0), actor: "user" as const },
    { mir: "MIR-027", from: "in_progress", to: "done", at: ist(2026, 5, 6, 12, 5), actor: "agent" as const, agent: MAYA.id },
  ];
  for (const c of issueStatusChanges) {
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        sql`${activityLog.companyId} = ${MIRA}::uuid AND ${activityLog.action} = 'issue.status_changed' AND ${activityLog.entityId} = ${c.mir} AND ${activityLog.createdAt} = ${c.at.toISOString()}::timestamptz`,
      );
    if (existing.length > 0) continue;
    activityRows.push({
      companyId: MIRA,
      actorType: c.actor,
      actorId: c.actor === "user" ? ANITA_AUTH_UID : ("agent" in c && c.agent ? c.agent : "system"),
      action: "issue.status_changed",
      entityType: "issue",
      entityId: c.mir,
      agentId: c.actor === "agent" && "agent" in c ? c.agent : undefined,
      details: {
        from: c.from,
        to: c.to,
        persona: PERSONA_TAG,
      },
      createdAt: c.at,
    });
  }

  // 6 workflow.completed entries — match the 6 workflow_runs.
  const wfActivityRefs = [
    { name: "Shore Capital welcome", at: ist(2026, 4, 23, 17, 14), key: "shore-welcome-2026-04-23", status: "completed" },
    { name: "Northwood renewal nudge", at: ist(2026, 5, 1, 10, 3), key: "renewal-northwood-2026-05-01", status: "completed" },
    { name: "Clearview renewal nudge", at: ist(2026, 5, 1, 10, 4), key: "renewal-clearview-2026-05-01", status: "completed" },
    { name: "Shore Capital renewal nudge", at: ist(2026, 5, 1, 10, 5), key: "renewal-shorecapital-2026-05-01", status: "completed" },
    { name: "Bake House renewal nudge", at: ist(2026, 5, 1, 10, 6), key: "renewal-bakehouse-2026-05-01", status: "completed" },
    { name: "Bake House overdue retry", at: ist(2026, 5, 7, 14, 30), key: "renewal-bakehouse-2026-05-07-overdue", status: "failed" },
  ];
  for (const wr of wfActivityRefs) {
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        sql`${activityLog.companyId} = ${MIRA}::uuid AND ${activityLog.action} = 'workflow.completed' AND ${activityLog.entityId} = ${wr.key}`,
      );
    if (existing.length > 0) continue;
    activityRows.push({
      companyId: MIRA,
      actorType: "system",
      actorId: "system",
      action: "workflow.completed",
      entityType: "workflow_run",
      entityId: wr.key,
      details: {
        name: wr.name,
        status: wr.status,
        persona: PERSONA_TAG,
      },
      createdAt: wr.at,
    });
  }

  // 2 budget incident lifecycle entries.
  {
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        sql`${activityLog.companyId} = ${MIRA}::uuid AND ${activityLog.action} = 'budget.incident.opened' AND ${activityLog.entityId} = ${THEO.id}`,
      );
    if (existing.length === 0) {
      activityRows.push({
        companyId: MIRA,
        actorType: "system",
        actorId: "system",
        action: "budget.incident.opened",
        entityType: "agent",
        entityId: THEO.id,
        agentId: THEO.id,
        details: {
          thresholdType: "hard_stop",
          amountObserved: 12500,
          amountLimit: 10000,
          persona: PERSONA_TAG,
        },
        createdAt: theoSpikeAt,
      });
      activityRows.push({
        companyId: MIRA,
        actorType: "user",
        actorId: ANITA_AUTH_UID,
        action: "budget.incident.resolved",
        entityType: "agent",
        entityId: THEO.id,
        agentId: THEO.id,
        details: {
          thresholdType: "hard_stop",
          resolution: "rate-limited theo to ≤4 concurrent",
          persona: PERSONA_TAG,
        },
        createdAt: theoResolvedAt,
      });
    }
    const existingMaya = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        sql`${activityLog.companyId} = ${MIRA}::uuid AND ${activityLog.action} = 'budget.incident.opened' AND ${activityLog.entityId} = ${MAYA.id}`,
      );
    if (existingMaya.length === 0) {
      activityRows.push({
        companyId: MIRA,
        actorType: "system",
        actorId: "system",
        action: "budget.incident.opened",
        entityType: "agent",
        entityId: MAYA.id,
        agentId: MAYA.id,
        details: {
          thresholdType: "warn",
          amountObserved: 13800,
          amountLimit: 15000,
          persona: PERSONA_TAG,
        },
        createdAt: mayaApproachAt,
      });
    }
  }

  if (activityRows.length > 0) {
    const ACT_CHUNK = 50;
    for (let i = 0; i < activityRows.length; i += ACT_CHUNK) {
      await tx.insert(activityLog).values(activityRows.slice(i, i + ACT_CHUNK));
    }
    summary.activityLog = activityRows.length;
  }

  // ─── 9. UPDATE agents.spent_monthly_cents + companies.spent_monthly_cents ──
  console.log("[seed-mira-labs-month1-finance] spend rollups…");

  // Sum cost_events.costCents per agent for this company.
  const spendRows = (await tx.execute(
    sql`SELECT agent_id::text AS agent_id, COALESCE(SUM(cost_cents), 0)::int AS spent FROM cost_events WHERE company_id = ${MIRA}::uuid GROUP BY agent_id`,
  )) as unknown as
    | Array<{ agent_id: string; spent: number }>
    | { rows: Array<{ agent_id: string; spent: number }> };
  const spendArr = Array.isArray(spendRows) ? spendRows : (spendRows.rows ?? []);
  let companyTotalCents = 0;
  for (const s of spendArr) {
    await tx
      .update(agents)
      .set({ spentMonthlyCents: s.spent, updatedAt: RUN_NOW })
      .where(eq(agents.id, s.agent_id));
    companyTotalCents += s.spent;
    summary.agentsUpdated++;
  }

  // Update companies.spent_monthly_cents only. metrics.deltas is left untouched
  // — Wave 1 / seed-mira-labs.ts already set up the metrics jsonb; the per-spec
  // hint to "refresh metrics.deltas" is not load-bearing for the UI right now
  // and we'd rather not race other waves writing to the same jsonb column.
  await tx
    .update(companies)
    .set({ spentMonthlyCents: companyTotalCents, updatedAt: RUN_NOW })
    .where(eq(companies.id, MIRA));
  summary.companyUpdated = 1;
});

// ─── End-of-run summary ───────────────────────────────────────────────────────
console.log(`
[seed-mira-labs-month1-finance] Inserted/updated:
  cost_events                : ${summary.costEvents}
  finance_events             : ${summary.financeEvents}
  marketing_spend            : ${summary.marketingSpend}
  budget_policies            : ${summary.budgetPolicies}
  budget_incidents           : ${summary.budgetIncidents}
  events                     : ${summary.events}
  workflows                  : ${summary.workflows}
  workflow_runs              : ${summary.workflowRuns}
  activity_log (delta)       : ${summary.activityLog}
  agents.spent_monthly_cents : ${summary.agentsUpdated} agents updated
  companies.spent_monthly_cents : ${summary.companyUpdated} company updated
`);

process.exit(0);
