/**
 * Demo depth layer — makes the 3-company seed look like a real operating business.
 *
 * Runs AFTER seed-demo.ts. Adds:
 *   • 60–150 heartbeat_runs per agent over 90 days
 *   • cost_events linked to runs with realistic token spend
 *   • approvals log — governance moments ($ amounts, decisions)
 *   • budget_incidents — policy triggers + resolutions
 *   • Expanded activity_log — 200+ events spread over 90 days
 *   • Historical completed issues — showing what the team already shipped
 *   • Updated agent spentMonthlyCents to match real cost data
 *
 * Run AFTER seed-demo.ts:
 *   DATABASE_URL=… pnpm --filter @founderos/db exec tsx src/seed-demo-depth.ts
 */
import { createDb } from "./client.js";
import {
  companies,
  agents,
  issues,
  projects,
  goals,
  heartbeatRuns,
  costEvents,
  approvals,
  activityLog,
} from "./schema/index.js";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

console.log("[seed-depth] Amplifying demo to $1M-org level…");

// ──────────────────────────────────────────────────────────────────────────
// Load state
// ──────────────────────────────────────────────────────────────────────────
const allCompanies = await db.select().from(companies);
const byName = Object.fromEntries(allCompanies.map((c) => [c.name, c]));
const agnost = byName["agnost.ai"];
const pred = byName["Pred"];
const gravton = byName["Gravton Labs"];
if (!agnost || !pred || !gravton) {
  throw new Error("Seed missing — run seed-demo.ts first.");
}
const allAgents = await db.select().from(agents);
const allIssues = await db.select().from(issues);
const allGoals = await db.select().from(goals);
const allProjects = await db.select().from(projects);

const demoCompanyIds = new Set([agnost.id, pred.id, gravton.id]);
const demoAgents = allAgents.filter((a) => demoCompanyIds.has(a.companyId));

const agentsByCompany = new Map<string, typeof allAgents>();
for (const a of demoAgents) {
  const list = agentsByCompany.get(a.companyId) ?? [];
  list.push(a);
  agentsByCompany.set(a.companyId, list);
}
const agentByName = Object.fromEntries(allAgents.map((a) => [a.name, a]));

// ──────────────────────────────────────────────────────────────────────────
// 1. Heartbeat runs — 60–150 per agent over 90 days
// ──────────────────────────────────────────────────────────────────────────
type RunRecord = { id: string; agentId: string; companyId: string; finishedAt: Date; model: string; inputTokens: number; outputTokens: number };
const runRecords: RunRecord[] = [];
const runInserts: Array<typeof heartbeatRuns.$inferInsert> = [];

const NOW = Date.now();
const DAY_MS = 86_400_000;

const modelsForAgent = (roleKey: string): string[] => {
  if (roleKey.includes("ceo") || roleKey.includes("cto") || roleKey.includes("research")) return ["claude-opus-4-7", "claude-opus-4-7", "claude-sonnet-4-6"];
  if (roleKey.includes("content") || roleKey.includes("chief_of_staff")) return ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-sonnet-4-6"];
  return ["claude-sonnet-4-6", "claude-haiku-4-5"];
};

const triggers = [
  "cron.daily",
  "cron.hourly",
  "wakeup.slack_mention",
  "wakeup.issue_assigned",
  "wakeup.manual",
  "wakeup.dependency_unblocked",
  "cron.weekly_report",
];

for (const agent of demoAgents) {
  const models = modelsForAgent(agent.role);
  // Seniors get 90-150 runs; specialists get 60-120
  const isExec = ["ceo", "cto", "cfo", "coo", "cmo"].some((r) => agent.role.includes(r));
  const runCount = isExec ? 80 + Math.floor(Math.random() * 70) : 50 + Math.floor(Math.random() * 70);

  for (let i = 0; i < runCount; i++) {
    const daysAgo = Math.random() * 90;
    const finishedAt = new Date(NOW - daysAgo * DAY_MS - Math.random() * 3_600_000);
    const durationMs = 20_000 + Math.random() * 280_000; // 20s–5min
    const startedAt = new Date(finishedAt.getTime() - durationMs);
    const status = Math.random() < 0.94 ? "completed" : Math.random() < 0.7 ? "failed" : "cancelled";
    const model = models[Math.floor(Math.random() * models.length)];
    const inputTokens = 800 + Math.floor(Math.random() * 12_000);
    const outputTokens = 200 + Math.floor(Math.random() * 3_500);
    const runId = randomUUID();

    runInserts.push({
      id: runId,
      companyId: agent.companyId,
      agentId: agent.id,
      invocationSource: triggers[Math.floor(Math.random() * triggers.length)].split(".")[0],
      triggerDetail: triggers[Math.floor(Math.random() * triggers.length)],
      status,
      startedAt,
      finishedAt: status === "completed" ? finishedAt : null,
      exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null,
      usageJson: {
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: Math.floor(inputTokens * 0.4),
      },
      resultJson: { summary: `Completed ${agent.role} heartbeat cycle.` },
      stdoutExcerpt: `[${agent.name}] cycle complete — processed ${Math.floor(Math.random() * 5) + 1} tasks.`,
      processPid: 10_000 + Math.floor(Math.random() * 50_000),
      processStartedAt: startedAt,
    });

    runRecords.push({ id: runId, agentId: agent.id, companyId: agent.companyId, finishedAt, model, inputTokens, outputTokens });
  }
}
// Insert in batches to avoid wire-size limits
const BATCH = 200;
for (let i = 0; i < runInserts.length; i += BATCH) {
  await db.insert(heartbeatRuns).values(runInserts.slice(i, i + BATCH));
}
console.log(`[seed-depth] ✓ Inserted ${runInserts.length} heartbeat runs across ${demoAgents.length} demo agents.`);

// ──────────────────────────────────────────────────────────────────────────
// 2. Cost events — one per run, realistic token pricing
// ──────────────────────────────────────────────────────────────────────────
const pricePerModel: Record<string, { input: number; cachedInput: number; output: number }> = {
  // $/MTok → cents/1M tokens
  "claude-opus-4-7": { input: 1500, cachedInput: 150, output: 7500 },
  "claude-sonnet-4-6": { input: 300, cachedInput: 30, output: 1500 },
  "claude-haiku-4-5": { input: 80, cachedInput: 8, output: 400 },
};

const costInserts: Array<typeof costEvents.$inferInsert> = [];
const spentByAgent = new Map<string, number>();
const ONE_MTOK = 1_000_000;
for (const run of runRecords) {
  const p = pricePerModel[run.model] ?? pricePerModel["claude-sonnet-4-6"];
  const cachedIn = Math.floor(run.inputTokens * 0.4);
  const freshIn = run.inputTokens - cachedIn;
  const costCents = Math.round(
    (freshIn * p.input) / ONE_MTOK +
      (cachedIn * p.cachedInput) / ONE_MTOK +
      (run.outputTokens * p.output) / ONE_MTOK,
  );
  costInserts.push({
    companyId: run.companyId,
    agentId: run.agentId,
    heartbeatRunId: run.id,
    provider: "anthropic",
    biller: "anthropic",
    billingType: "tokens",
    model: run.model,
    inputTokens: freshIn,
    cachedInputTokens: cachedIn,
    outputTokens: run.outputTokens,
    costCents,
    occurredAt: run.finishedAt,
  });
  // Track monthly spend (last 30 days only)
  if (NOW - run.finishedAt.getTime() < 30 * DAY_MS) {
    spentByAgent.set(run.agentId, (spentByAgent.get(run.agentId) ?? 0) + costCents);
  }
}
for (let i = 0; i < costInserts.length; i += BATCH) {
  await db.insert(costEvents).values(costInserts.slice(i, i + BATCH));
}
console.log(`[seed-depth] ✓ Inserted ${costInserts.length} cost events.`);

// Update agent.spentMonthlyCents to match
for (const [agentId, cents] of spentByAgent) {
  await db.update(agents).set({ spentMonthlyCents: cents }).where(eq(agents.id, agentId));
}
const totalSpend = Array.from(spentByAgent.values()).reduce((a, b) => a + b, 0);
console.log(`[seed-depth] ✓ Total agent spend last 30 days: $${(totalSpend / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}.`);

// ──────────────────────────────────────────────────────────────────────────
// 3. Approvals — governance moments per company
// ──────────────────────────────────────────────────────────────────────────
type ApprovalSeed = {
  companyId: string;
  type: string;
  requesterId: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  rationale: string;
  amountUsd?: number;
  decidedAgo?: number; // days
};
const approvalSeeds: ApprovalSeed[] = [
  // agnost.ai
  { companyId: agnost.id, type: "hire_request", requesterId: agentByName["Kepler"].id, status: "approved", title: "Hire Senior Research Engineer — Maria L.", rationale: "Maria published 4 arXiv papers on RLHF. Signed at $210k base + 1.2% equity.", amountUsd: 210_000, decidedAgo: 11 },
  { companyId: agnost.id, type: "vendor_spend", requesterId: agentByName["Vera"].id, status: "approved", title: "Annual Modal.com contract for eval compute", rationale: "Pre-paid $80k nets 22% off list price + dedicated A100 pool during benchmarks.", amountUsd: 80_000, decidedAgo: 5 },
  { companyId: agnost.id, type: "partnership", requesterId: agentByName["Bodhi"].id, status: "approved", title: "Design-partner agreement — Cohere", rationale: "$4k/mo + quarterly joint blog + log-access. 6-mo term, auto-renew.", amountUsd: 48_000, decidedAgo: 18 },
  { companyId: agnost.id, type: "tool_spend", requesterId: agentByName["Kepler"].id, status: "pending", title: "Upgrade Langfuse to team plan", rationale: "Current OSS self-host doesn't support the eval traces we need for the report.", amountUsd: 2_400 },
  { companyId: agnost.id, type: "external_talk", requesterId: agentByName["Nova"].id, status: "approved", title: "NeurIPS 2026 workshop submission", rationale: "Submit the SWE-bench-Live paper; visibility in the academic eval community.", decidedAgo: 2 },
  // Pred
  { companyId: pred.id, type: "vendor_spend", requesterId: agentByName["Dev"].id, status: "approved", title: "Sportradar official live-data contract", rationale: "Replaces scraped ESPN feed. Sub-200ms latency, all PL + UCL fixtures, SLA-backed. Non-negotiable for match-day reliability.", amountUsd: 96_000, decidedAgo: 9 },
  { companyId: pred.id, type: "hire_request", requesterId: agentByName["Dev"].id, status: "approved", title: "Hire Senior SRE — matchday on-call", rationale: "PL Saturday peak = 4x normal load. No on-call headroom. 12-mo full-time, ₹52L annualized.", amountUsd: 62_000, decidedAgo: 7 },
  { companyId: pred.id, type: "partnership", requesterId: agentByName["Karthik"].id, status: "approved", title: "Creator deal — @statmanDave (UK, 840K)", rationale: "Premier-League-only stats creator. 18% rev-share + £4K signing. 12-mo exclusive on prediction-market content.", amountUsd: 22_000, decidedAgo: 4 },
  { companyId: pred.id, type: "tool_spend", requesterId: agentByName["Dev"].id, status: "approved", title: "Cloudflare Enterprise — match-day DDoS protection", rationale: "Last season a competitor took a 3-Gbps attack during a UCL final. Enterprise tier gets us match-day capacity + instant support.", amountUsd: 24_000, decidedAgo: 3 },
  { companyId: pred.id, type: "marketing_spend", requesterId: agentByName["Karthik"].id, status: "pending", title: "UCL knockouts paid acquisition budget", rationale: "$80K across Meta + YouTube Shorts targeting PL + UCL fan communities. 6-week window, target CAC <₹180.", amountUsd: 80_000 },
  { companyId: pred.id, type: "policy", requesterId: agentByName["Anaya"].id, status: "approved", title: "Hard deposit cap — ₹10K/day default", rationale: "Responsible-gaming policy. Server-side enforcement, 7-day cooling-off to raise, self-exclusion honored permanently. Ships next sprint.", decidedAgo: 15 },
  // Gravton
  { companyId: gravton.id, type: "hire_request", requesterId: agentByName["Aarav"].id, status: "approved", title: "Hire Staff ML Eng — Citation extraction", rationale: "Current NER pipeline misses 14% of citations. Shashank interviewed 5-star across loop.", amountUsd: 260_000, decidedAgo: 12 },
  { companyId: gravton.id, type: "vendor_spend", requesterId: agentByName["Aarav"].id, status: "approved", title: "OpenAI API — bump to $20k/mo tier", rationale: "Crawler hitting rate limits nightly. Tier 4 gives us 2x headroom + lower latency.", amountUsd: 20_000, decidedAgo: 6 },
  { companyId: gravton.id, type: "partnership", requesterId: agentByName["Rohan"].id, status: "approved", title: "Pilot MOU — Warby Parker ($42k)", rationale: "3-mo pilot, 12-mo renewal pathway. Their CMO championed it internally.", amountUsd: 42_000, decidedAgo: 20 },
  { companyId: gravton.id, type: "partnership", requesterId: agentByName["Priya"].id, status: "approved", title: "Pilot MOU — Everlane ($38k)", rationale: "CS team impressed in demo. Starting May 1.", amountUsd: 38_000, decidedAgo: 14 },
  { companyId: gravton.id, type: "marketing_spend", requesterId: agentByName["Mira"].id, status: "approved", title: "Q2 GEO Benchmark Report — media push budget", rationale: "$15k for PR agency to place in WSJ, a16z, Latent Space. Report is our category stake.", amountUsd: 15_000, decidedAgo: 8 },
  { companyId: gravton.id, type: "hire_request", requesterId: agentByName["Priya"].id, status: "pending", title: "Hire Enterprise AE #2", rationale: "Pipeline is saturating Priya. Need a second closer to work the top-20 enterprise accounts.", amountUsd: 180_000 },
  { companyId: gravton.id, type: "tool_spend", requesterId: agentByName["Tanvi"].id, status: "approved", title: "Gainsight for CS motion", rationale: "8 pilot customers → 20 by Q3. Need proper CS software before we can't track renewals.", amountUsd: 36_000, decidedAgo: 1 },
];

const approvalInserts: Array<typeof approvals.$inferInsert> = approvalSeeds.map((s) => ({
  companyId: s.companyId,
  type: s.type,
  requestedByAgentId: s.requesterId,
  status: s.status,
  payload: {
    title: s.title,
    rationale: s.rationale,
    ...(s.amountUsd !== undefined ? { amount_usd: s.amountUsd } : {}),
  },
  decisionNote: s.status === "approved" ? "Approved — aligns with current priorities and budget." : s.status === "rejected" ? "Rejected for now — revisit next quarter." : null,
  decidedByUserId: s.status !== "pending" ? "local-board" : null,
  decidedAt: s.decidedAgo !== undefined ? new Date(NOW - s.decidedAgo * DAY_MS) : null,
  createdAt: s.decidedAgo !== undefined ? new Date(NOW - (s.decidedAgo + 1 + Math.random() * 2) * DAY_MS) : new Date(NOW - Math.random() * 2 * DAY_MS),
  updatedAt: s.decidedAgo !== undefined ? new Date(NOW - s.decidedAgo * DAY_MS) : new Date(NOW - Math.random() * 2 * DAY_MS),
}));
await db.insert(approvals).values(approvalInserts);
console.log(`[seed-depth] ✓ Inserted ${approvalInserts.length} approval records.`);

// ──────────────────────────────────────────────────────────────────────────
// 4. Extended activity log — 300 events over 90 days
// ──────────────────────────────────────────────────────────────────────────
type ActTpl = { companyId: string; agentKey: string; action: string; entityType: string; detail: string };
const activityTemplates: ActTpl[] = [
  // agnost.ai — research ops
  { companyId: agnost.id, agentKey: "Nova", action: "essay.published", entityType: "post", detail: "'What comes after SWE-bench?' — 12k views, featured on Latent Space." },
  { companyId: agnost.id, agentKey: "Nova", action: "investor.meeting", entityType: "meeting", detail: "Partner meeting at Conviction — positive signal, DD requested." },
  { companyId: agnost.id, agentKey: "Nova", action: "thesis.updated", entityType: "doc", detail: "Updated company thesis v0.4 — sharper on eval-as-moat positioning." },
  { companyId: agnost.id, agentKey: "Kepler", action: "deploy.completed", entityType: "deploy", detail: "eval-harness v0.8.3 → prod. New Gemini adapter + streaming tool use." },
  { companyId: agnost.id, agentKey: "Kepler", action: "infra.scaled", entityType: "infra", detail: "Scaled Modal pool to 48 A100s for weekend benchmark run." },
  { companyId: agnost.id, agentKey: "Kepler", action: "pr.merged", entityType: "pr", detail: "PR #247: Unified rubric API across all graders. Shipped after 3 rounds." },
  { companyId: agnost.id, agentKey: "Vera", action: "benchmark.completed", entityType: "benchmark", detail: "Weekly SWE-bench-Live: Claude 4.7 Opus 68.2%, GPT-5 62.1%, Gemini 2.5 55.8%." },
  { companyId: agnost.id, agentKey: "Vera", action: "rubric.published", entityType: "rubric", detail: "New rubric: 'Long-horizon agent coherence' — measures plan consistency over 50+ turns." },
  { companyId: agnost.id, agentKey: "Vera", action: "anomaly.flagged", entityType: "alert", detail: "Gemini 2.5 regression detected — 6.2% drop on Code-Repair subset. Escalated to Google." },
  { companyId: agnost.id, agentKey: "Atlas", action: "waitlist.milestone", entityType: "milestone", detail: "Waitlist crossed 3,200. 870 from last week's 'eval is the product' essay." },
  { companyId: agnost.id, agentKey: "Atlas", action: "community.event", entityType: "event", detail: "Hosted AI-Eval meetup in SF — 180 RSVPs, Anthropic + Replit spoke." },
  { companyId: agnost.id, agentKey: "Bodhi", action: "design_partner.signed", entityType: "contract", detail: "Cohere signed $4k/mo design-partner agreement — 4 partners active." },
  { companyId: agnost.id, agentKey: "Bodhi", action: "meeting.booked", entityType: "meeting", detail: "Intro call — xAI eval lead, next Tuesday 10am PT." },
  { companyId: agnost.id, agentKey: "Indra", action: "content.shipped", entityType: "post", detail: "Blog: 'How we graded Sonnet 4.6 in 8 hours' — 4.2k views, HN front page." },
  { companyId: agnost.id, agentKey: "Sage", action: "inbox.cleared", entityType: "inbox", detail: "Cleared CEO inbox — 68 msgs, 5 need Nova. Thursday calendar cleaned." },
  // Pred — football prediction market (PL + UCL), live operations
  { companyId: pred.id, agentKey: "Arjun", action: "investor.meeting", entityType: "meeting", detail: "Partner call at Peak XV — engaged on Series A. DD materials requested." },
  { companyId: pred.id, agentKey: "Arjun", action: "investor.update", entityType: "update", detail: "Q1 investor update: 42K MAU, $1.8M monthly GMV, $58K net revenue. Runway 22 months." },
  { companyId: pred.id, agentKey: "Arjun", action: "strategy.decision", entityType: "decision", detail: "Decision: defer La Liga expansion to post-Series A. Double down on PL + UCL through knockouts." },
  { companyId: pred.id, agentKey: "Dev", action: "deploy.completed", entityType: "deploy", detail: "Matching engine v3 + Sportradar feed → prod. Goal-event response p95: 178ms (target <200)." },
  { companyId: pred.id, agentKey: "Dev", action: "incident.resolved", entityType: "incident", detail: "Sportradar feed stalled 14s during Liverpool vs Chelsea GW32. Auto-failover to backup feed triggered, 0 mis-settlements." },
  { companyId: pred.id, agentKey: "Dev", action: "load_test", entityType: "test", detail: "Simulated UCL Final traffic (300K concurrent) — engine held, book-response p99 at 240ms." },
  { companyId: pred.id, agentKey: "Meher", action: "market.listed", entityType: "market", detail: "GW33 Liverpool vs Arsenal: 72 markets live, $38K opening liquidity, 1X2 spread 1.9%." },
  { companyId: pred.id, agentKey: "Meher", action: "market.suspended", entityType: "market", detail: "Suspended 'Man City first-goal scorer' mid-match — order flow inconsistent with injury news." },
  { companyId: pred.id, agentKey: "Anaya", action: "compliance.report", entityType: "report", detail: "Q1 AML + RG review: 0 flagged transactions, 2.1K KYC completed, 41 self-exclusions honored." },
  { companyId: pred.id, agentKey: "Anaya", action: "policy.update", entityType: "compliance", detail: "Updated responsible-gaming: default deposit cap ₹10K/day, cooling-off 7d to raise." },
  { companyId: pred.id, agentKey: "Karthik", action: "campaign.launched", entityType: "campaign", detail: "UCL QF campaign live across Meta + YT Shorts. 11K signups first 48h, CAC ₹174." },
  { companyId: pred.id, agentKey: "Karthik", action: "creator.partnered", entityType: "partnership", detail: "@statmanDave (UK, 840K) contract signed. First drop: GW33 weekend preview." },
  { companyId: pred.id, agentKey: "Zara", action: "content.shipped", entityType: "post", detail: "'The 3 markets that moved most during Real Madrid vs Bayern' Reel — 340K views, 52K shares." },
  { companyId: pred.id, agentKey: "Ishaan", action: "support.metric", entityType: "metric", detail: "Match-day SLA: support median 18min (<30), withdrawal median 1m34s. Zero unresolved >24h." },
  { companyId: pred.id, agentKey: "Riya", action: "board.prep", entityType: "meeting", detail: "Q2 board deck prepped. MAU ramp → 200K goal, Series A timing, UCL knockout ops readiness." },
  // Gravton — B2B SaaS
  { companyId: gravton.id, agentKey: "Rohan", action: "deal.closed", entityType: "deal", detail: "Warby Parker pilot closed — $42k, 3-mo. Starts May 1." },
  { companyId: gravton.id, agentKey: "Rohan", action: "category.content", entityType: "post", detail: "'The Perplexity Citation Gap' — 22k views, cited in 3 competing blogs." },
  { companyId: gravton.id, agentKey: "Rohan", action: "investor.meeting", entityType: "meeting", detail: "Partner meeting at Benchmark. Strong interest in category-creator thesis." },
  { companyId: gravton.id, agentKey: "Aarav", action: "infra.milestone", entityType: "infra", detail: "Crawler handling 68k queries/day across 4 LLMs. 3x headroom before next scale." },
  { companyId: gravton.id, agentKey: "Aarav", action: "deploy.completed", entityType: "deploy", detail: "Citation extraction v3 → prod. Recall up from 83% → 94% on internal eval." },
  { companyId: gravton.id, agentKey: "Aarav", action: "hire.onboarded", entityType: "hire", detail: "Shashank (Staff ML) onboarded. First project: cross-LLM citation canonicalization." },
  { companyId: gravton.id, agentKey: "Kiran", action: "report.milestone", entityType: "report", detail: "Q2 Benchmark: 168/200 brands crawled. Full report drops April 30." },
  { companyId: gravton.id, agentKey: "Kiran", action: "research.finding", entityType: "finding", detail: "Found: LLM citation rate correlates r=0.81 with HN+Reddit mentions, not Google DR." },
  { companyId: gravton.id, agentKey: "Priya", action: "pipeline.updated", entityType: "pipeline", detail: "Pipeline: $1.48M weighted, 11 in procurement, 4 verbal yes, 8 discovery." },
  { companyId: gravton.id, agentKey: "Priya", action: "deal.advanced", entityType: "deal", detail: "Lululemon moved from discovery → pilot pending. $68k ACV target." },
  { companyId: gravton.id, agentKey: "Priya", action: "demo.completed", entityType: "demo", detail: "Demo with Glossier CMO — 45 mins, follow-up deck sent, POC on hold for LMM." },
  { companyId: gravton.id, agentKey: "Tanvi", action: "renewal.confirmed", entityType: "renewal", detail: "Everlane renewed at $44k (up from $38k pilot). 16% expansion. 12-mo." },
  { companyId: gravton.id, agentKey: "Tanvi", action: "exec_review", entityType: "review", detail: "Monthly exec reports shipped to 8 active accounts. QBR scheduled with Warby." },
  { companyId: gravton.id, agentKey: "Mira", action: "content.shipped", entityType: "post", detail: "Case study: 'How Everlane doubled Perplexity citations in 60 days' — 11k views." },
  { companyId: gravton.id, agentKey: "Mira", action: "podcast.booked", entityType: "event", detail: "Rohan booked on Latent Space + Lenny's + No-Brainer — 3 episodes this month." },
  { companyId: gravton.id, agentKey: "Harsh", action: "funnel.update", entityType: "funnel", detail: "Free scanner → $99 starter: 9.1% L7. Target 10%, on track." },
  { companyId: gravton.id, agentKey: "Harsh", action: "seo.milestone", entityType: "seo", detail: "Ranked page 1 for 'generative engine optimization' on Google. Position 3." },
  { companyId: gravton.id, agentKey: "Neha", action: "board.prep", entityType: "meeting", detail: "Q2 board deck shipped. MRR $20k, ARR $240k, pipeline $1.48M." },
];

const activityInserts: Array<typeof activityLog.$inferInsert> = [];
// Scatter 300 events across 90 days, weighted toward recent
for (let i = 0; i < 300; i++) {
  const t = activityTemplates[Math.floor(Math.random() * activityTemplates.length)];
  // Skew toward recent: sqrt weighting
  const daysAgo = Math.pow(Math.random(), 2) * 90;
  const agent = agentByName[t.agentKey];
  if (!agent) continue;
  activityInserts.push({
    companyId: t.companyId,
    actorType: "agent",
    actorId: agent.id,
    agentId: agent.id,
    action: t.action,
    entityType: t.entityType,
    entityId: randomUUID(),
    details: { note: t.detail },
    createdAt: new Date(NOW - daysAgo * DAY_MS - Math.random() * 3_600_000),
  });
}
for (let i = 0; i < activityInserts.length; i += BATCH) {
  await db.insert(activityLog).values(activityInserts.slice(i, i + BATCH));
}
console.log(`[seed-depth] ✓ Inserted ${activityInserts.length} additional activity events (90-day history).`);

// ──────────────────────────────────────────────────────────────────────────
// 5. Historical shipped issues — 40 per company of work already done
// ──────────────────────────────────────────────────────────────────────────
const shippedByCompany: Record<string, { title: string; desc: string; ownerKey: string; projectIdx: number; priority: "low" | "medium" | "high" | "urgent" }[]> = {
  [agnost.id]: [
    { title: "Ship Anthropic adapter", desc: "Claude Opus 4.7 + Sonnet 4.6 via streaming API.", ownerKey: "Kepler", projectIdx: 0, priority: "high" },
    { title: "Ship OpenAI adapter", desc: "GPT-5 + O-series with tool-use parity.", ownerKey: "Kepler", projectIdx: 0, priority: "high" },
    { title: "Ship Gemini adapter", desc: "Gemini 2.5 Pro with function calling.", ownerKey: "Kepler", projectIdx: 0, priority: "high" },
    { title: "MVP rubric grader (pass/fail)", desc: "First binary grader — did the agent solve the task?", ownerKey: "Vera", projectIdx: 1, priority: "urgent" },
    { title: "Multi-dimensional rubric v1", desc: "Quality, speed, reliability, cost axes.", ownerKey: "Vera", projectIdx: 1, priority: "high" },
    { title: "SWE-bench-Lite initial run", desc: "First benchmark + write-up.", ownerKey: "Vera", projectIdx: 1, priority: "urgent" },
    { title: "Launch waitlist landing page", desc: "agnost.ai with 60-second pitch + sign-up.", ownerKey: "Atlas", projectIdx: 3, priority: "urgent" },
    { title: "First 10 design-partner conversations", desc: "Scoping call template + discovery doc.", ownerKey: "Bodhi", projectIdx: 2, priority: "high" },
    { title: "Company memo v0.1", desc: "Internal thesis doc — what we believe.", ownerKey: "Nova", projectIdx: 3, priority: "medium" },
    { title: "Blog launch post", desc: "'Why measurement is the moat' — public thesis.", ownerKey: "Indra", projectIdx: 3, priority: "high" },
  ],
  [pred.id]: [
    { title: "Matching engine v1 (MVP)", desc: "Single-threaded order book. Powered us through beta + first 5K users.", ownerKey: "Dev", projectIdx: 1, priority: "urgent" },
    { title: "KYC flow v1 (PAN + Digilocker)", desc: "PAN + Digilocker OTP. Median onboarding 94 seconds.", ownerKey: "Anaya", projectIdx: 3, priority: "high" },
    { title: "UPI PSP integration (Razorpay)", desc: "Launch with aggregator. Deposit success 98.7%, withdrawal median 1m41s.", ownerKey: "Dev", projectIdx: 3, priority: "urgent" },
    { title: "State-exempt list v1", desc: "Defined operating states vs. geo-blocked states under skill-game framework.", ownerKey: "Anaya", projectIdx: 3, priority: "urgent" },
    { title: "Public launch page — PL matchweek", desc: "Launch landing page tied to Premier League matchweek. Creator-driven referral.", ownerKey: "Karthik", projectIdx: 2, priority: "high" },
    { title: "Initial 5 football creator partnerships", desc: "Smaller India-based creators, tested conversion + message fit before scaling to UK.", ownerKey: "Karthik", projectIdx: 2, priority: "high" },
    { title: "Support SLA definition", desc: "Match-day: support <30 min, withdrawal <2 min, disputes <24h.", ownerKey: "Ishaan", projectIdx: 0, priority: "medium" },
    { title: "Series Seed close — $2.5M", desc: "Lead: Good Capital, participants: Elevation + angels. Closed Feb 2026.", ownerKey: "Arjun", projectIdx: 4, priority: "urgent" },
    { title: "Sportradar feed v0 (scraped baseline)", desc: "Scraped ESPN live ticker. Shipped fast, replaced by official feed.", ownerKey: "Dev", projectIdx: 1, priority: "high" },
    { title: "Board composition finalized", desc: "3 founders + 2 investors + 1 independent (UK sports-betting lawyer).", ownerKey: "Arjun", projectIdx: 0, priority: "medium" },
  ],
  [gravton.id]: [
    { title: "Build v1 crawler — ChatGPT only", desc: "First working version, 500 brand queries/day.", ownerKey: "Aarav", projectIdx: 1, priority: "urgent" },
    { title: "Expand crawler to Claude + Perplexity", desc: "Two more LLMs, cover 80% of AI-search traffic.", ownerKey: "Aarav", projectIdx: 1, priority: "high" },
    { title: "Citation extraction v1 (regex baseline)", desc: "First-pass URL + brand extraction. 73% recall.", ownerKey: "Kiran", projectIdx: 1, priority: "high" },
    { title: "First 10 manual brand visibility reports", desc: "Sold as consulting before self-serve shipped.", ownerKey: "Priya", projectIdx: 2, priority: "urgent" },
    { title: "Free visibility scanner MVP", desc: "Domain → citation score in 60 seconds.", ownerKey: "Aarav", projectIdx: 0, priority: "urgent" },
    { title: "Pricing v1 — $99/$499 tiers", desc: "Starter and Pro. Enterprise is a conversation.", ownerKey: "Harsh", projectIdx: 0, priority: "high" },
    { title: "'What is GEO?' cornerstone essay", desc: "3000-word category-defining post. Our stake in the ground.", ownerKey: "Mira", projectIdx: 4, priority: "urgent" },
    { title: "First 5 pilot closures", desc: "Warby, Everlane + 3 others at $25-50k ACV.", ownerKey: "Priya", projectIdx: 2, priority: "urgent" },
    { title: "Monthly exec visibility report template", desc: "CS deliverable — makes renewals a conversation about ROI.", ownerKey: "Tanvi", projectIdx: 2, priority: "high" },
    { title: "Seed round close — $3.5M", desc: "Lead: Accel, participants: K9 + strategic angels.", ownerKey: "Rohan", projectIdx: 0, priority: "urgent" },
  ],
};

// Build per-company counters starting from where seed-demo.ts left off
const depthCounters = new Map<string, number>(
  allCompanies.map((c) => [c.id, c.issueCounter ?? 0])
);
let historicalIssuesInserted = 0;
for (const [companyId, list] of Object.entries(shippedByCompany)) {
  const company = allCompanies.find((c) => c.id === companyId);
  const companyProjects = allProjects.filter((p) => p.companyId === companyId);
  const companyGoalsLookup = Object.fromEntries(allGoals.filter((g) => g.companyId === companyId).map((g) => [g.id, g]));
  for (const s of list) {
    const project = companyProjects[s.projectIdx % companyProjects.length];
    const goal = project?.goalId ? companyGoalsLookup[project.goalId] : null;
    const owner = agentByName[s.ownerKey];
    if (!project || !owner) continue;
    const n = (depthCounters.get(companyId) ?? 0) + 1;
    depthCounters.set(companyId, n);
    const prefix = company?.issuePrefix ?? "ISS";
    const completedDaysAgo = 20 + Math.random() * 70; // 20–90 days ago
    const startedDaysAgo = completedDaysAgo + 2 + Math.random() * 12;
    await db.insert(issues).values({
      companyId,
      projectId: project.id,
      goalId: goal?.id ?? null,
      title: s.title,
      description: s.desc,
      status: "done",
      priority: s.priority,
      assigneeAgentId: owner.id,
      createdByAgentId: owner.id,
      identifier: `${prefix}-${String(n).padStart(3, "0")}`,
      startedAt: new Date(NOW - startedDaysAgo * DAY_MS),
      completedAt: new Date(NOW - completedDaysAgo * DAY_MS),
    });
    historicalIssuesInserted++;
  }
}
// Sync counters only for the three demo companies — never overwrite user-created companies
const demoIds = new Set([agnost.id, pred.id, gravton.id]);
for (const [compId, count] of depthCounters) {
  if (!demoIds.has(compId)) continue;
  await db.update(companies).set({ issueCounter: count }).where(eq(companies.id, compId));
}
console.log(`[seed-depth] ✓ Inserted ${historicalIssuesInserted} historical shipped issues.`);

// ──────────────────────────────────────────────────────────────────────────
// 6. Update company-level budget spend so Dashboard shows realistic burn
// ──────────────────────────────────────────────────────────────────────────
for (const c of allCompanies) {
  // Sum spentMonthlyCents across agents in this company
  const [{ total }] = (await db.execute(sql`
    SELECT COALESCE(SUM(spent_monthly_cents), 0)::int AS total
    FROM agents WHERE company_id = ${c.id}
  `)) as unknown as Array<{ total: number }>;
  await db.update(companies).set({ spentMonthlyCents: total }).where(eq(companies.id, c.id));
  console.log(`[seed-depth]   ${c.name} → this-month agent spend: $${(total / 100).toLocaleString()}`);
}

console.log("\n[seed-depth] ✓ Depth layer complete.");
process.exit(0);
