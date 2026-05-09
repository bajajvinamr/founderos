/**
 * Demo narrative layer — interview-ready surfaces.
 *
 * Runs AFTER seed-demo.ts and seed-demo-depth.ts. Adds:
 *   • company_memory — 10-12 insider-sounding lessons per company (the "how we
 *     actually think" artifact that makes the board room look real).
 *   • approvals     — 6-8 additional Decision Inbox items per company with
 *     plausible mix of pending/approved/rejected and real-world stakes.
 *   • integrations  — 3 connected integrations per company (slack, hubspot,
 *     posthog by default) with keyHint + connectedAt set.
 *   • integration_data — 20-40 kind-varied cache rows per integration,
 *     showing recent syncs (contacts, deals, events, messages, funnels).
 *
 * Optionally tacks on a lightweight "Little Wins" 4th company flagged as
 * experimental — CBSE/BBPS context, doesn't compete with the main three.
 *
 * Run AFTER the first two seeds:
 *   DATABASE_URL=… pnpm --filter @founderos/db exec tsx src/seed-demo-narrative.ts
 */
import { createDb } from "./client.js";
import {
  companies,
  agents,
  approvals,
  companyMemory,
  integrations,
  integrationData,
  activityLog,
} from "./schema/index.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

if (process.env.FOUNDEROS_SEED_DEMO !== "1") {
  console.error(
    "[seed-demo-narrative] Refusing to run: this script writes demo-only " +
      "company memory + integrations into the configured DATABASE_URL. Set " +
      "FOUNDEROS_SEED_DEMO=1 to confirm you are pointing at a development/test " +
      "database, never production. See docs/runbooks/seed-demo.md for safe usage.",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

console.log("[seed-narrative] Wiring memory + decision inbox + integrations…");

// ──────────────────────────────────────────────────────────────────────────
// Load state
// ──────────────────────────────────────────────────────────────────────────
const allCompanies = await db.select().from(companies);
const byName = Object.fromEntries(allCompanies.map((c) => [c.name, c]));
const acme = byName["Acme Robotics"];
const beta = byName["Beta Labs"];
const demoCorp = byName["Demo Corp"];
if (!acme || !beta || !demoCorp) {
  throw new Error(
    "Core 3-company seed missing. Run seed-demo.ts and seed-demo-depth.ts first.",
  );
}

const allAgents = await db.select().from(agents);
const agentByName = Object.fromEntries(allAgents.map((a) => [a.name, a]));

const NOW = Date.now();
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

const pickAgent = (name: string) => {
  const a = agentByName[name];
  if (!a) throw new Error(`[seed-narrative] Agent not found by name: ${name}`);
  return a;
};

// ══════════════════════════════════════════════════════════════════════════
// 1. Company memory — 10-12 per company
// ══════════════════════════════════════════════════════════════════════════

type MemorySeed = {
  companyId: string;
  kind: "weekly_summary" | "experiment_outcome" | "founder_note" | "milestone";
  title: string;
  body: string;
  topic?: string;
  daysAgo: number;
  pinned?: boolean;
};

const memorySeeds: MemorySeed[] = [
  // ─── Acme Robotics ────────────────────────────────────────────────────────
  {
    companyId: acme.id,
    kind: "founder_note",
    title: "Labs buy eval throughput, not model quality",
    body:
      "Frontier lab partners keep asking the same question in different wrappers: 'how fast can we iterate?'. They care about eval throughput, not model quality. Pitch the harness first, the rubric science second. Nobody closes on 'we have better taste' — everyone closes on 'we save you 3 weeks per eval cycle'.",
    topic: "positioning",
    daysAgo: 21,
    pinned: true,
  },
  {
    companyId: acme.id,
    kind: "experiment_outcome",
    title: "SWE-bench-Live beat SWE-bench-Verified on churn",
    body:
      "Week 3 result: SWE-bench-Verified scores saturate — every lab hits ~65% and stops. Our Live variant (scraped daily) shows a 4-8pp churn week-over-week. That churn IS the product. We now pitch it as 'the only benchmark that can still surprise you'.",
    topic: "evals",
    daysAgo: 17,
  },
  {
    companyId: acme.id,
    kind: "weekly_summary",
    title: "Week of Apr 7 — Anthropic DP signed, Cohere scoping",
    body:
      "Shipped: Anthropic design-partner agreement (first money in, $4k/mo). Cohere scoping call went well, likely close within 2 weeks. Blocked: Gemini adapter rate-limited on Google's free tier — need to upgrade.",
    topic: "ops",
    daysAgo: 14,
  },
  {
    companyId: acme.id,
    kind: "founder_note",
    title: "Don't ship a closed-source rubric SDK",
    body:
      "Tempting to keep the grader IP closed-source for moat. Fought internally — Kepler was right: open the harness MIT, keep the commercial rubrics + managed benchmarks closed. Community trust compounds; they only pay for the service, not the code.",
    topic: "strategy",
    daysAgo: 28,
    pinned: true,
  },
  {
    companyId: acme.id,
    kind: "experiment_outcome",
    title: "HN front page drives research engineers, not customers",
    body:
      "'The eval is the product' hit HN front page (420 upvotes). 2,100 signups in 24 hours. Zero enterprise inbound. Research engineers at labs are the right ICP; downstream customers don't read HN. Budget HN launches for hiring + DP funnel, not revenue.",
    topic: "growth",
    daysAgo: 9,
  },
  {
    companyId: acme.id,
    kind: "founder_note",
    title: "Reproducibility is the only defensible claim in AI",
    body:
      "Every vendor says they're 'better at agents'. The only claim that survives scrutiny: 'here is the code, here is the data, here is the number — run it yourself.' Every blog post ends with a reproduce button. No exceptions.",
    topic: "values",
    daysAgo: 35,
    pinned: true,
  },
  {
    companyId: acme.id,
    kind: "milestone",
    title: "First DP revenue — $4k MRR",
    body:
      "Anthropic signed first paying DP agreement. First revenue in the door Feb 2026. Psychological unlock for the team.",
    topic: "revenue",
    daysAgo: 45,
  },
  {
    companyId: acme.id,
    kind: "experiment_outcome",
    title: "Paper-first launches work, product-first launches don't",
    body:
      "Tried two sequences this quarter: (a) ship product → write blog, (b) write paper → release code. Sequence (b) drove 3.2x waitlist signups and 100% of DP intros. Always lead with the intellectual artifact.",
    topic: "marketing",
    daysAgo: 52,
  },
  {
    companyId: acme.id,
    kind: "founder_note",
    title: "Kepler's hiring bar: 'can another lab replicate in 2 weeks?'",
    body:
      "Every research-eng candidate asked: take a recent paper, pitch how you'd replicate the core result in 2 weeks. Two-hour working session, not a whiteboard grind. Filters for taste + speed simultaneously. Three hires, zero regrets.",
    topic: "hiring",
    daysAgo: 40,
  },
  {
    companyId: acme.id,
    kind: "weekly_summary",
    title: "Week of Mar 24 — 1k GitHub stars in 48h",
    body:
      "eval-harness v0.7 release post hit 1,040 stars in 48 hours. First-time contributor PRs open: 14. Biggest outside contributor: someone from Meta AI infra shipping a Llama-3 adapter. That's exactly the pattern we want.",
    topic: "community",
    daysAgo: 32,
  },
  {
    companyId: acme.id,
    kind: "experiment_outcome",
    title: "Discord beats Slack for research communities",
    body:
      "Moved the community from Slack to Discord in February. DAU tripled. Threads are what researchers actually want — Slack channels collapse context every day. Not a marketing choice; an operational one.",
    topic: "community",
    daysAgo: 60,
  },

  // ─── Beta Labs ────────────────────────────────────────────────────────────
  {
    companyId: beta.id,
    kind: "founder_note",
    title: "EPL Saturday matchdays are 4x weekday GMV",
    body:
      "Always pre-warm the Razorpay HPP at T-30 min before kickoff. Cold HPP adds 800ms to checkout, which shows up as a 3-4% drop in completed deposits on peak matches. Dev has this in the matchday runbook now, but anyone on-call needs to know.",
    topic: "matchday-ops",
    daysAgo: 18,
    pinned: true,
  },
  {
    companyId: beta.id,
    kind: "experiment_outcome",
    title: "Cricket is a trap — PL+UCL wedge is our moat",
    body:
      "Q4 last year we tried listing IPL markets. Regulatory heat went up 10x — three state advisories in six weeks. Pulled the plug. Lesson: 'skill game' framing holds for foreign leagues (PL/UCL) where Indian courts haven't set precedent. Never revisit domestic cricket.",
    topic: "regulatory",
    daysAgo: 120,
    pinned: true,
  },
  {
    companyId: beta.id,
    kind: "founder_note",
    title: "Kill suspicious markets within 90 seconds",
    body:
      "Meher's rule: any market showing >3 sigma order-flow skew in 60 seconds gets suspended automatically. Manual review after. We've had 4 attempted manipulation events this season; caught 4, settled 0. This is the difference between a platform and a casino.",
    topic: "market-integrity",
    daysAgo: 25,
    pinned: true,
  },
  {
    companyId: beta.id,
    kind: "weekly_summary",
    title: "Week of Apr 7 — GW32 Liverpool vs Chelsea",
    body:
      "Peak concurrency 78K (+22% vs last week). GMV $640K for the weekend (~35% of monthly). One Sportradar feed stall at 72' — auto-failover worked, 0 mis-settlements. Karthik signed @statmanDave (UK, 840K). Matchday support SLA 17min median.",
    topic: "ops",
    daysAgo: 14,
  },
  {
    companyId: beta.id,
    kind: "experiment_outcome",
    title: "UK creators convert better than Indian PL fanclubs",
    body:
      "First 6 creator deals split evenly UK/India. UK creators drove ₹142 CAC; Indian PL-fanclub creators drove ₹318. UK fans already know prediction-market language. Swapped the next 5 slots to UK-only. Saves ~₹20L/quarter on wasted creator spend.",
    topic: "growth",
    daysAgo: 22,
  },
  {
    companyId: beta.id,
    kind: "founder_note",
    title: "FIU filings are discovery, not paperwork",
    body:
      "Every STR-0 we file, Anaya drafts a 1-page memo on what we learned. Quarterly filings have become our best internal reg-intel channel. Last quarter's memo surfaced a UPI collusion pattern that caught 3 users before they withdrew — saved ₹4L in potential chargebacks.",
    topic: "compliance",
    daysAgo: 30,
  },
  {
    companyId: beta.id,
    kind: "experiment_outcome",
    title: "Live commentary Reels settle faster than text wraps",
    body:
      "Post-match: tested text wrap vs 60-sec Reel with Zara voice-over. Reel drove 6.2x social shares and 3.1x next-session returns. Text wraps are dead for our audience. Zara is now on-cam; budget accordingly.",
    topic: "content",
    daysAgo: 40,
  },
  {
    companyId: beta.id,
    kind: "milestone",
    title: "Crossed 40K MAU",
    body:
      "42,100 MAU reached in April. 18% MoM growth. Path to 200K by end of UCL knockouts is visible if UCL QF campaign hits CAC target.",
    topic: "growth",
    daysAgo: 8,
  },
  {
    companyId: beta.id,
    kind: "founder_note",
    title: "Never ship limits that users can instantly raise",
    body:
      "Responsible-gaming rule: any limit a user can raise in <24h is not a limit. Deposit cap raises require 7-day cooling-off. Self-exclusion is permanent, registered by hashed PAN. This is non-negotiable even for VIP customers; lost 3 customers, retained the license.",
    topic: "compliance",
    daysAgo: 55,
    pinned: true,
  },
  {
    companyId: beta.id,
    kind: "experiment_outcome",
    title: "Pre-match market lists drive 40% of pre-kickoff deposits",
    body:
      "Started publishing the 72-market list 48h before each marquee fixture. Pre-kickoff deposits up 40% on those fixtures vs. control. Users want to plan their positions. Formalized into Meher's matchday workflow.",
    topic: "markets",
    daysAgo: 50,
  },
  {
    companyId: beta.id,
    kind: "weekly_summary",
    title: "Week of Mar 10 — Series Seed closed",
    body:
      "$2.5M Series Seed closed, lead Good Capital + Elevation. Board composition: 3 founders, 2 investors, 1 independent (UK sports-betting lawyer for reg credibility). Money in the bank Mar 14.",
    topic: "fundraise",
    daysAgo: 42,
  },

  // ─── Demo Corp ────────────────────────────────────────────────────────────
  {
    companyId: demoCorp.id,
    kind: "founder_note",
    title: "Warby Parker renewed on citation lift, not rank",
    body:
      "Warby only renewed because we showed a 23% lift in Perplexity citations over 90 days. When we pitched 'rank improvement' nobody cared; when we pitched 'citation frequency' the CMO leaned in. Track citation lift, not rank. Ever. This reframes the entire product.",
    topic: "product",
    daysAgo: 12,
    pinned: true,
  },
  {
    companyId: demoCorp.id,
    kind: "experiment_outcome",
    title: "Free scanner → paid: 9.1% at $99 beats 4.2% at $49",
    body:
      "Assumed lowering Starter price would lift conversion. Wrong. $49 tier had 4.2% conversion; $99 tier had 9.1%. The free scanner filters for serious brands; serious brands want a 'real' tool. Raising price reduced churn in free→paid by half.",
    topic: "pricing",
    daysAgo: 18,
  },
  {
    companyId: demoCorp.id,
    kind: "founder_note",
    title: "GEO category creation = one essay per month forever",
    body:
      "Rohan's rule: one category-defining essay per month, no exceptions. Not product blog, not company update — a pure 'what is this category' essay. Three competitors already cite 'What is GEO?'. That's what winning a category looks like before anyone realizes it happened.",
    topic: "marketing",
    daysAgo: 25,
    pinned: true,
  },
  {
    companyId: demoCorp.id,
    kind: "experiment_outcome",
    title: "Enterprise demos: lead with their brand, not our platform",
    body:
      "Priya changed her demo opener from 'here is Demo Corp' to 'here is how Lululemon actually appears in Claude right now' — screen-shared live. Close rate went from 18% to 44% over 14 demos. Never pitch the platform first; pitch the buyer's reality.",
    topic: "sales",
    daysAgo: 20,
  },
  {
    companyId: demoCorp.id,
    kind: "founder_note",
    title: "Citation rate correlates with HN + Reddit, not Google DR",
    body:
      "Kiran's finding from the Q2 benchmark: r=0.81 correlation between LLM citation rate and HN/Reddit mentions. Google DR correlation: r=0.22. This is the whole pitch now — GEO is a different discipline from SEO, with different signals. Cite this in every pitch.",
    topic: "research",
    daysAgo: 10,
    pinned: true,
  },
  {
    companyId: demoCorp.id,
    kind: "weekly_summary",
    title: "Week of Apr 7 — Everlane renewed at +16%",
    body:
      "Everlane renewed $38k → $44k (12-mo). Lululemon moved discovery → pilot-pending. Shipped citation extraction v3 (recall 83% → 94%). Rohan booked on Latent Space + Lenny's. Shashank (Staff ML) onboarded, first project: cross-LLM canonicalization.",
    topic: "ops",
    daysAgo: 14,
  },
  {
    companyId: demoCorp.id,
    kind: "experiment_outcome",
    title: "Podcast circuit outperforms paid SEO 10x",
    body:
      "Spent $8k on SEO content agency in Q1. Drove 40 enterprise-qualified leads. Spent $0 on podcast circuit (Rohan's time only). Drove 410 qualified leads. Podcast circuit is the moat; SEO agency contract not renewed.",
    topic: "marketing",
    daysAgo: 35,
  },
  {
    companyId: demoCorp.id,
    kind: "founder_note",
    title: "OpenAI rate limits are the ceiling, not infra cost",
    body:
      "Aarav: 'Our crawler could 10x tomorrow if OpenAI lifted Tier 4.' Infra costs are ~$6k/mo. Rate-limit headroom is what gates growth. Buy enough credit to stay in Tier 4, always. Pre-pay quarterly when Anthropic offers it.",
    topic: "infra",
    daysAgo: 28,
  },
  {
    companyId: demoCorp.id,
    kind: "milestone",
    title: "11 signed pilots, $352K total ACV",
    body:
      "Crossed 11 signed pilots at average $32K ACV. Warby, Everlane, Third Love, Parachute Home, Away, and 6 more. 29 pilots still in flight. Series A narrative: 'we created a category and have 40 enterprise customers testing it'.",
    topic: "revenue",
    daysAgo: 5,
    pinned: true,
  },
  {
    companyId: demoCorp.id,
    kind: "experiment_outcome",
    title: "Page-1 Google for 'generative engine optimization' drives inbound",
    body:
      "Ranked position 3 for 'generative engine optimization' on Google. 8 qualified inbound enterprise leads in the first two weeks. SEO is not dead for category terms — it's the only place that word lives while we're creating it.",
    topic: "marketing",
    daysAgo: 42,
  },
  {
    companyId: demoCorp.id,
    kind: "founder_note",
    title: "CS delivers monthly exec reports — the renewal happens here",
    body:
      "Tanvi's rule: every pilot gets a polished exec visibility report on day 30 and day 60. By day 90 the buyer is selling the renewal internally, not us. Our churn is 0% on accounts that read 2+ exec reports. Never skimp on CS deliverables.",
    topic: "cs",
    daysAgo: 50,
  },
  {
    companyId: demoCorp.id,
    kind: "weekly_summary",
    title: "Week of Mar 24 — Benchmark Report hit the WSJ citation",
    body:
      "Q2 Benchmark Report draft showed to a WSJ reporter friend-of-friend. Got cited in a B2B AI article. Immediate effect: 3 inbound enterprise demos the next week, including Lululemon's CMO.",
    topic: "pr",
    daysAgo: 30,
  },
];

const memoryInserts: Array<typeof companyMemory.$inferInsert> = memorySeeds.map(
  (m) => ({
    companyId: m.companyId,
    kind: m.kind,
    title: m.title,
    body: m.body,
    topic: m.topic ?? null,
    occurredAt: new Date(NOW - m.daysAgo * DAY_MS - Math.random() * HOUR_MS),
    pinned: m.pinned ?? false,
    source: "manual",
  }),
);

await db.insert(companyMemory).values(memoryInserts);
console.log(
  `[seed-narrative] ✓ Inserted ${memoryInserts.length} company_memory entries.`,
);

// ══════════════════════════════════════════════════════════════════════════
// 2. Approvals — additional Decision Inbox items (6-8 per company)
// ══════════════════════════════════════════════════════════════════════════

type ApprovalSeed = {
  companyId: string;
  type: string;
  requesterName: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  rationale: string;
  amountUsd?: number;
  decidedAgo?: number; // days ago; undefined if pending
  decisionNote?: string;
};

const approvalSeeds: ApprovalSeed[] = [
  // ─── Acme Robotics ────────────────────────────────────────────────────────
  {
    companyId: acme.id,
    type: "vendor_spend",
    requesterName: "Vera",
    status: "pending",
    title: "Together.ai compute budget — $14k/mo for Llama-3 adapter evals",
    rationale:
      "Need to benchmark Llama-3-405B on SWE-bench-Live. Together.ai is the only provider running it on MI300X at reasonable latency. 3-month commit, auto-renewal off.",
    amountUsd: 42_000,
  },
  {
    companyId: acme.id,
    type: "partnership",
    requesterName: "Bodhi",
    status: "approved",
    title: "DP agreement — DeepMind Applied Eval team ($5k/mo, 6mo)",
    rationale:
      "Larger org, slower cycle but bigger logo halo. Paul K. championed it; brings Gemini 2.5 log access for our benchmark.",
    amountUsd: 30_000,
    decidedAgo: 4,
    decisionNote:
      "Approved — 4th DP, keeps us on track for 5-by-seed-round goal.",
  },
  {
    companyId: acme.id,
    type: "external_talk",
    requesterName: "Nova",
    status: "approved",
    title: "Keynote — AIEngWorld Summit (SF, May 14)",
    rationale:
      "30-min slot right after Anthropic's keynote. Category-defining moment for Acme. Talk title: 'The eval is the product'.",
    decidedAgo: 6,
    decisionNote: "Approved — exactly the audience we're recruiting from.",
  },
  {
    companyId: acme.id,
    type: "hire_request",
    requesterName: "Kepler",
    status: "rejected",
    title: "Hire second CTO-candidate — ex-OAI infra lead",
    rationale:
      "Candidate is strong but wants $290k + 4% equity at pre-seed. Our band is $220k + 1.5%. Closing him would reset the whole comp band.",
    amountUsd: 290_000,
    decidedAgo: 9,
    decisionNote:
      "Rejected — equity ask breaks the band. Revisit at seed when we can offer larger cash + lower %.",
  },
  {
    companyId: acme.id,
    type: "tool_spend",
    requesterName: "Sage",
    status: "approved",
    title: "Notion → Linear migration (company-wide)",
    rationale:
      "Engineering is already on Linear; research team still on Notion. Unifying tracking before we scale past 10 people.",
    amountUsd: 4_800,
    decidedAgo: 2,
  },
  {
    companyId: acme.id,
    type: "marketing_spend",
    requesterName: "Atlas",
    status: "pending",
    title: "Sponsor EleutherAI Discord ($3k/mo, 6 mo)",
    rationale:
      "EleutherAI Discord is 38k research engineers. Sponsorship gets us a pinned announcement channel + monthly AMA slot.",
    amountUsd: 18_000,
  },
  {
    companyId: acme.id,
    type: "policy",
    requesterName: "Nova",
    status: "approved",
    title: "Open-source rubric SDK under Apache 2.0",
    rationale:
      "Harness is already MIT. Opening rubric SDK under Apache 2.0 drives adoption — commercial rubrics + managed evals stay closed-source.",
    decidedAgo: 13,
    decisionNote:
      "Approved — Kepler's 'open the tools, close the service' framework.",
  },

  // ─── Beta Labs ────────────────────────────────────────────────────────────
  {
    companyId: beta.id,
    type: "vendor_spend",
    requesterName: "Dev",
    status: "pending",
    title: "Razorpay Enterprise HPP upgrade — $8k/mo + 0.15% fee",
    rationale:
      "Standard HPP cold-starts 800ms on matchdays. Enterprise tier gives us warmed instances + 24/7 payments SLA during PL + UCL windows. Payback in <2 months based on recovered deposit conversion.",
    amountUsd: 96_000,
  },
  {
    companyId: beta.id,
    type: "partnership",
    requesterName: "Karthik",
    status: "rejected",
    title: "Creator deal — @CricketManiaIN (2.1M, India)",
    rationale:
      "Huge reach but 100% cricket. Would force us to list IPL markets which kills the reg-framing. Say no politely — refer them to fantasy sports peers.",
    amountUsd: 180_000,
    decidedAgo: 11,
    decisionNote:
      "Rejected — cricket is a trap, PL+UCL wedge is the moat. No exceptions.",
  },
  {
    companyId: beta.id,
    type: "policy",
    requesterName: "Anaya",
    status: "approved",
    title: "Self-exclusion registry — industry-shared hash pool",
    rationale:
      "Hashed PAN registry shared with 3 peer platforms. A user self-excluded on us stays excluded across all 4. Costs us ~₹80K in lost GMV/year; worth it for reg credibility.",
    decidedAgo: 3,
    decisionNote: "Approved — the exact kind of voluntary move regulators remember.",
  },
  {
    companyId: beta.id,
    type: "hire_request",
    requesterName: "Meher",
    status: "pending",
    title: "Hire 2nd Markets Analyst — UCL coverage (London-based)",
    rationale:
      "UCL knockout window + PL run-in simultaneously is 14 fixtures/week. Solo Meher burning out. London-based to overlap with European matches.",
    amountUsd: 84_000,
  },
  {
    companyId: beta.id,
    type: "marketing_spend",
    requesterName: "Zara",
    status: "approved",
    title: "UCL Final live-stream watch-along ($35K production + talent)",
    rationale:
      "Rent Mumbai studio, 3 football creators on-cam, Reels + YouTube live throughout. Projected 800K unique viewers, CAC ₹120.",
    amountUsd: 35_000,
    decidedAgo: 1,
    decisionNote: "Approved — single biggest matchday of the year. Go big.",
  },
  {
    companyId: beta.id,
    type: "vendor_spend",
    requesterName: "Ishaan",
    status: "approved",
    title: "Intercom → Zendesk migration (match-day SLA)",
    rationale:
      "Intercom breaks under 3K concurrent matchday tickets. Zendesk Enterprise handles it, $2.8K/mo + migration fee.",
    amountUsd: 38_000,
    decidedAgo: 7,
  },
  {
    companyId: beta.id,
    type: "external_talk",
    requesterName: "Arjun",
    status: "pending",
    title: "TiECon Bangalore — Fireside on 'skill-game frameworks in India'",
    rationale:
      "30-min fireside with a gov'ment policy advisor. Unfiltered public position on regulatory thesis. Risk: quoted out of context on cricket. Reward: credibility with next 10 investors.",
  },
  {
    companyId: beta.id,
    type: "policy",
    requesterName: "Anaya",
    status: "approved",
    title: "Geo-block 5 additional states after April notification",
    rationale:
      "Five states issued advisories post the Mar 28 court order. Out of abundance of caution, geo-block and honor pending withdrawals for 30 days. Lose ~4% GMV short-term.",
    decidedAgo: 5,
    decisionNote: "Approved — defensive posture. Revisit post-Series A.",
  },

  // ─── Demo Corp ────────────────────────────────────────────────────────────
  {
    companyId: demoCorp.id,
    type: "partnership",
    requesterName: "Priya",
    status: "pending",
    title: "Pilot MOU — Lululemon ($68K ACV, 3mo pilot → 12mo)",
    rationale:
      "CMO championed internally. Procurement in flight. Biggest logo in the pipeline — unlocks the 'if Lulu does it' conversation with the next 10 DTC brands.",
    amountUsd: 68_000,
  },
  {
    companyId: demoCorp.id,
    type: "vendor_spend",
    requesterName: "Aarav",
    status: "pending",
    title: "Anthropic Tier 5 pre-pay — $60K quarterly",
    rationale:
      "Tier 4 saturates every week. Pre-pay Tier 5 unlocks 3x rate limit + 12% discount. Crawler bottleneck disappears.",
    amountUsd: 60_000,
  },
  {
    companyId: demoCorp.id,
    type: "hire_request",
    requesterName: "Rohan",
    status: "approved",
    title: "Hire VP Marketing (category-creation focus)",
    rationale:
      "Mira can't ship one essay/month + run the benchmark + do the podcast circuit. VP-level hire with B2B category experience. Targeted candidate: ex-Segment, ex-Notion content leads.",
    amountUsd: 240_000,
    decidedAgo: 4,
    decisionNote:
      "Approved — category creation is the moat; need senior capacity.",
  },
  {
    companyId: demoCorp.id,
    type: "marketing_spend",
    requesterName: "Mira",
    status: "rejected",
    title: "Superbowl-adjacent brand campaign — $400K",
    rationale:
      "Category-awareness play. 30-second spot + OOH in SF + NYC. Ambitious.",
    amountUsd: 400_000,
    decidedAgo: 22,
    decisionNote:
      "Rejected — we are bootstrapped. Podcast circuit outperforms paid 10x at this stage. Revisit post-raise.",
  },
  {
    companyId: demoCorp.id,
    type: "tool_spend",
    requesterName: "Priya",
    status: "approved",
    title: "Apollo.io for enterprise outbound",
    rationale:
      "Need structured data on 500 target DTC CMOs. Apollo has the freshest data + LinkedIn integration.",
    amountUsd: 14_400,
    decidedAgo: 8,
  },
  {
    companyId: demoCorp.id,
    type: "external_talk",
    requesterName: "Rohan",
    status: "approved",
    title: "Latent Space podcast — 'GEO as a discipline' (2-hour)",
    rationale:
      "Swyx booked 2-hour deep dive for May. Most reaches research engineers; ICP match is perfect.",
    decidedAgo: 2,
  },
  {
    companyId: demoCorp.id,
    type: "partnership",
    requesterName: "Kiran",
    status: "pending",
    title: "Co-author Q3 Benchmark with Semrush (attribution split)",
    rationale:
      "Semrush has brand tracking data we don't. Co-authorship grants joint distribution to their 150K-brand email list. Risk: dilutes our category-creation stake.",
  },
  {
    companyId: demoCorp.id,
    type: "vendor_spend",
    requesterName: "Tanvi",
    status: "approved",
    title: "Loom Enterprise for monthly exec video reports",
    rationale:
      "Replacing written monthly reports with 3-min Looms. Tanvi tested on 3 accounts — buyers watch 92% vs. 34% read-through on written reports.",
    amountUsd: 7_200,
    decidedAgo: 6,
    decisionNote: "Approved — better renewal signal, lower time cost.",
  },
];

const approvalInserts: Array<typeof approvals.$inferInsert> = approvalSeeds.map(
  (s) => {
    const decidedAt =
      s.decidedAgo !== undefined
        ? new Date(NOW - s.decidedAgo * DAY_MS - Math.random() * HOUR_MS)
        : null;
    const createdAt =
      s.decidedAgo !== undefined
        ? new Date(
            NOW - (s.decidedAgo + 1 + Math.random() * 3) * DAY_MS,
          )
        : new Date(NOW - Math.random() * 4 * DAY_MS);
    return {
      companyId: s.companyId,
      type: s.type,
      requestedByAgentId: pickAgent(s.requesterName).id,
      status: s.status,
      payload: {
        title: s.title,
        rationale: s.rationale,
        ...(s.amountUsd !== undefined ? { amount_usd: s.amountUsd } : {}),
      },
      decisionNote:
        s.decisionNote ??
        (s.status === "approved"
          ? "Approved."
          : s.status === "rejected"
            ? "Rejected."
            : null),
      decidedByUserId: s.status !== "pending" ? "local-board" : null,
      decidedAt,
      createdAt,
      updatedAt: decidedAt ?? createdAt,
    };
  },
);

await db.insert(approvals).values(approvalInserts);
console.log(
  `[seed-narrative] ✓ Inserted ${approvalInserts.length} additional approval records.`,
);

// ══════════════════════════════════════════════════════════════════════════
// 3. Integrations + integration_data (3 connected per company)
// ══════════════════════════════════════════════════════════════════════════

type IntegrationSpec = {
  companyId: string;
  kind: "slack" | "hubspot" | "posthog" | "notion" | "linkedin";
  keyHint: string;
  config: Record<string, unknown>;
  connectedDaysAgo: number;
};

const integrationSpecs: IntegrationSpec[] = [
  // Acme Robotics — slack + hubspot + posthog (research + DP funnel tracking)
  {
    companyId: acme.id,
    kind: "slack",
    keyHint: "7s4A",
    config: {
      team_id: "T04ACME",
      team_name: "Acme Robotics",
      default_channel: "C04OPS",
    },
    connectedDaysAgo: 58,
  },
  {
    companyId: acme.id,
    kind: "hubspot",
    keyHint: "b21C",
    config: {
      portal_id: "46204108",
      account_name: "Acme Robotics",
    },
    connectedDaysAgo: 42,
  },
  {
    companyId: acme.id,
    kind: "posthog",
    keyHint: "phc_",
    config: {
      project_id: "9024",
      host: "https://app.posthog.com",
    },
    connectedDaysAgo: 50,
  },

  // Beta Labs — slack + hubspot + posthog (matchday ops + CRM + product analytics)
  {
    companyId: beta.id,
    kind: "slack",
    keyHint: "9k2P",
    config: {
      team_id: "T09BETA",
      team_name: "Beta Labs",
      default_channel: "C09MATCHDAY",
    },
    connectedDaysAgo: 180,
  },
  {
    companyId: beta.id,
    kind: "hubspot",
    keyHint: "f4T2",
    config: {
      portal_id: "52119874",
      account_name: "Beta Labs",
    },
    connectedDaysAgo: 120,
  },
  {
    companyId: beta.id,
    kind: "posthog",
    keyHint: "phc_",
    config: {
      project_id: "11842",
      host: "https://app.posthog.com",
    },
    connectedDaysAgo: 160,
  },

  // Demo Corp — slack + hubspot + posthog (enterprise pipeline heavy)
  {
    companyId: demoCorp.id,
    kind: "slack",
    keyHint: "3x8G",
    config: {
      team_id: "T03DEMO",
      team_name: "Demo Corp",
      default_channel: "C03GTM",
    },
    connectedDaysAgo: 95,
  },
  {
    companyId: demoCorp.id,
    kind: "hubspot",
    keyHint: "a9D1",
    config: {
      portal_id: "47712203",
      account_name: "Demo Corp",
    },
    connectedDaysAgo: 88,
  },
  {
    companyId: demoCorp.id,
    kind: "posthog",
    keyHint: "phc_",
    config: {
      project_id: "14503",
      host: "https://app.posthog.com",
    },
    connectedDaysAgo: 75,
  },
];

// Insert integrations (upsert-like: if a row exists via depth layer, skip).
const integrationRecords: Array<{
  integrationId: string;
  companyId: string;
  kind: IntegrationSpec["kind"];
}> = [];

for (const spec of integrationSpecs) {
  const existing = await db
    .select()
    .from(integrations)
    .where(eq(integrations.companyId, spec.companyId));
  const already = existing.find((r) => r.kind === spec.kind);
  if (already) {
    // Update existing to connected state
    await db
      .update(integrations)
      .set({
        status: "connected",
        keyHint: spec.keyHint,
        config: spec.config,
        connectedAt: new Date(NOW - spec.connectedDaysAgo * DAY_MS),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, already.id));
    integrationRecords.push({
      integrationId: already.id,
      companyId: spec.companyId,
      kind: spec.kind,
    });
  } else {
    const [inserted] = await db
      .insert(integrations)
      .values({
        companyId: spec.companyId,
        kind: spec.kind,
        status: "connected",
        keyHint: spec.keyHint,
        encryptedApiKey: null,
        config: spec.config,
        connectedAt: new Date(NOW - spec.connectedDaysAgo * DAY_MS),
      })
      .returning();
    if (!inserted) throw new Error("Integration insert returned no row");
    integrationRecords.push({
      integrationId: inserted.id,
      companyId: spec.companyId,
      kind: spec.kind,
    });
  }
}
console.log(
  `[seed-narrative] ✓ Upserted ${integrationRecords.length} integrations (3 per company, all connected).`,
);

// ──────────────────────────────────────────────────────────────────────────
// 3b. integration_data — varied-kind cache rows per integration
// ──────────────────────────────────────────────────────────────────────────

/**
 * integration_data has a UNIQUE constraint on (companyId, integrationId, kind).
 * We build 20-40 rows per integration by varying the kind suffix (e.g.
 * "slack.channels.summary", "slack.messages.last_24h", "slack.users.active",
 * "hubspot.deals.top", "hubspot.contacts.recent", "posthog.funnels.signup"...).
 */

type DataSeed = { kind: string; payload: Record<string, unknown>; daysAgo?: number };

const slackRows = (companyName: string, channelHint: string): DataSeed[] => [
  {
    kind: "slack.channels.summary",
    payload: {
      total_channels: 22 + Math.floor(Math.random() * 12),
      active_last_7d: 11 + Math.floor(Math.random() * 6),
      primary: channelHint,
    },
  },
  {
    kind: "slack.channels.recent_activity",
    payload: {
      channels: [
        { name: "#ops", messages_7d: 284 },
        { name: "#matchday", messages_7d: 612 },
        { name: channelHint, messages_7d: 418 },
        { name: "#dealflow", messages_7d: 92 },
        { name: "#eng", messages_7d: 1_041 },
      ],
    },
  },
  {
    kind: "slack.users.active",
    payload: {
      active_7d: 14,
      active_30d: 18,
      note: `${companyName} workspace — active member snapshot`,
    },
  },
  {
    kind: "slack.messages.sample",
    payload: {
      messages: [
        {
          user: "Arjun",
          channel: "#ops",
          text: "GW33 market list locked. Meher + Dev reviewing last 4 edge cases.",
          ts_minutes_ago: 12,
        },
        {
          user: "Dev",
          channel: "#eng",
          text: "Sportradar latency p95 back to 172ms after hot-fix. Closing the page.",
          ts_minutes_ago: 35,
        },
        {
          user: "Karthik",
          channel: "#growth",
          text: "statmanDave signed. First drop goes Sat 3pm IST.",
          ts_minutes_ago: 58,
        },
      ],
    },
  },
  {
    kind: "slack.digest.daily",
    payload: {
      top_threads: 5,
      mentions_for_board: 2,
      open_decisions: 3,
    },
  },
  {
    kind: "slack.usage.commands",
    payload: {
      slash_commands_7d: 42,
      top_command: "/founderos brief",
    },
  },
  {
    kind: "slack.integrations.bots",
    payload: {
      bots: ["github", "linear", "pagerduty", "stripe"],
      foundros_bot_version: "1.4.2",
    },
  },
];

const hubspotRows = (): DataSeed[] => [
  {
    kind: "hubspot.deals.open",
    payload: {
      count: 29,
      total_value_cents: 1_480_000_00,
      top_stage: "negotiation",
    },
  },
  {
    kind: "hubspot.deals.top",
    payload: {
      deals: [
        { name: "Lululemon — pilot", stage: "procurement", amount_cents: 68_00_00 * 100 },
        { name: "Glossier — pilot", stage: "demo_complete", amount_cents: 52_00_00 * 100 },
        { name: "Away — pilot", stage: "verbal", amount_cents: 44_00_00 * 100 },
        { name: "Parachute Home — pilot", stage: "discovery", amount_cents: 36_00_00 * 100 },
      ],
    },
  },
  {
    kind: "hubspot.deals.won_30d",
    payload: {
      count: 3,
      total_value_cents: 124_00_00 * 100,
      logos: ["Warby Parker", "Everlane", "Third Love"],
    },
  },
  {
    kind: "hubspot.contacts.recent",
    payload: {
      new_7d: 28,
      new_30d: 142,
      last_synced: new Date().toISOString(),
    },
  },
  {
    kind: "hubspot.pipeline.stages",
    payload: {
      stages: [
        { name: "discovery", count: 14 },
        { name: "demo", count: 9 },
        { name: "procurement", count: 4 },
        { name: "verbal", count: 2 },
      ],
    },
  },
  {
    kind: "hubspot.engagement.last_7d",
    payload: { emails_sent: 312, meetings_booked: 18, calls_logged: 41 },
  },
  {
    kind: "hubspot.owners.load",
    payload: {
      owners: [
        { name: "Priya", open_deals: 22, quota_attainment: 0.72 },
      ],
    },
  },
];

const posthogRows = (): DataSeed[] => [
  {
    kind: "posthog.funnels.signup",
    payload: {
      funnel: "landing → signup → activated",
      steps: [
        { step: "landing", count: 24_500 },
        { step: "signup", count: 2_210 },
        { step: "activated", count: 1_320 },
      ],
      conversion_overall: 0.054,
      window_days: 7,
    },
  },
  {
    kind: "posthog.funnels.paid",
    payload: {
      funnel: "free_scan → paid",
      conversion_rate: 0.091,
      target: 0.1,
      sample_n: 2_210,
    },
  },
  {
    kind: "posthog.channels.utm_source",
    payload: {
      last_7d: [
        { source: "twitter", pageviews: 9_140, signups: 412 },
        { source: "hn", pageviews: 4_210, signups: 390 },
        { source: "podcast", pageviews: 3_008, signups: 187 },
        { source: "organic", pageviews: 5_540, signups: 202 },
      ],
    },
  },
  {
    kind: "posthog.events.top",
    payload: {
      events: [
        { name: "scan_started", count_7d: 2_210 },
        { name: "scan_completed", count_7d: 2_104 },
        { name: "report_viewed", count_7d: 1_422 },
        { name: "checkout_clicked", count_7d: 392 },
        { name: "subscription_created", count_7d: 212 },
      ],
    },
  },
  {
    kind: "posthog.retention.cohorts",
    payload: {
      cohorts: [
        { week: "-3", d1: 0.44, d7: 0.28, d30: 0.19 },
        { week: "-2", d1: 0.47, d7: 0.31, d30: 0.21 },
        { week: "-1", d1: 0.51, d7: 0.33, d30: null },
      ],
    },
  },
  {
    kind: "posthog.feature_flags.rollout",
    payload: {
      flags: [
        { key: "v3_matching_engine", enabled_pct: 100 },
        { key: "exec_report_loom", enabled_pct: 34 },
        { key: "self_serve_upgrade", enabled_pct: 100 },
      ],
    },
  },
  {
    kind: "posthog.sessions.daily",
    payload: {
      days: Array.from({ length: 14 }).map((_, i) => ({
        day_offset: -i,
        sessions: 4_800 + Math.floor(Math.random() * 2_200),
      })),
    },
  },
  {
    kind: "posthog.errors.top",
    payload: {
      errors: [
        { type: "PaymentTimeout", count_7d: 18 },
        { type: "WebhookRetry", count_7d: 7 },
        { type: "AuthRefresh", count_7d: 4 },
      ],
    },
  },
];

const dataInserts: Array<typeof integrationData.$inferInsert> = [];

for (const rec of integrationRecords) {
  const rows: DataSeed[] =
    rec.kind === "slack"
      ? slackRows(
          allCompanies.find((c) => c.id === rec.companyId)?.name ?? "Unknown",
          rec.kind === "slack" ? "#general" : "#general",
        )
      : rec.kind === "hubspot"
        ? hubspotRows()
        : rec.kind === "posthog"
          ? posthogRows()
          : [];

  // Amplify to 20-40 rows by suffixing each kind with a sync id so rows stay
  // unique under the (companyId, integrationId, kind) constraint.
  const amplified: DataSeed[] = [];
  for (let i = 0; i < rows.length; i++) amplified.push(rows[i]!);
  // Expand each base row with 2-4 "historical snapshots" using kind suffixes.
  for (let i = 0; i < rows.length; i++) {
    const base = rows[i]!;
    const snapshotCount = 2 + Math.floor(Math.random() * 3); // 2–4 extra
    for (let s = 1; s <= snapshotCount; s++) {
      amplified.push({
        kind: `${base.kind}.snapshot.${s}`,
        payload: {
          ...base.payload,
          snapshot_at: new Date(NOW - s * DAY_MS).toISOString(),
          snapshot_id: s,
        },
        daysAgo: s,
      });
    }
  }

  for (const row of amplified) {
    dataInserts.push({
      companyId: rec.companyId,
      integrationId: rec.integrationId,
      kind: row.kind,
      payload: row.payload,
      fetchedAt: new Date(
        NOW - (row.daysAgo ?? 0) * DAY_MS - Math.random() * 30 * MIN_MS,
      ),
    });
  }
}

// Insert in batches
const BATCH = 200;
for (let i = 0; i < dataInserts.length; i += BATCH) {
  await db.insert(integrationData).values(dataInserts.slice(i, i + BATCH));
}
console.log(
  `[seed-narrative] ✓ Inserted ${dataInserts.length} integration_data rows (~${Math.round(dataInserts.length / integrationRecords.length)} per integration).`,
);

// ══════════════════════════════════════════════════════════════════════════
// 4. (Optional) Little Wins — experimental 4th company
// ══════════════════════════════════════════════════════════════════════════
// ~150-line footprint. Flagged experimental so it doesn't compete with the
// main three for the interview. Kept brief on purpose.

const existingLW = allCompanies.find((c) => c.name === "Little Wins");
if (!existingLW) {
  const [littleWins] = await db
    .insert(companies)
    .values({
      name: "Little Wins",
      description:
        "[EXPERIMENTAL DEMO] Child-development screening for Indian CBSE schools. BBPS payment integration is the warmest lead. Pre-seed, pre-revenue. Not the primary demo — kept in for scenario variety.",
      issuePrefix: "LTW",
      status: "active",
      budgetMonthlyCents: 40_000, // $400
      metrics: {
        stage: "Pre-seed · Experimental",
        tagline: "Child-dev screening · CBSE wedge · BBPS-integrated billing",
        customersSigned: 0,
        pipelineCount: 8,
        monthlyBurnCents: 40_000,
        runwayMonths: 9,
        keyAccounts: ["BBPS (warmest lead)", "3 CBSE pilot schools"],
        nextMilestoneLabel: "First 3 pilot schools Q3",
      },
    })
    .returning();

  if (!littleWins) throw new Error("Little Wins insert failed");

  const [lwCEO] = await db
    .insert(agents)
    .values({
      companyId: littleWins.id,
      name: "Anvi",
      role: "ceo",
      title: "Founder — Little Wins",
      icon: "🌱",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-6",
        maxTurnsPerRun: 20,
        dangerouslySkipPermissions: true,
        promptTemplate:
          "You are Anvi, founder of Little Wins. You run child-developmental screening for Indian CBSE schools. The wedge is: CBSE compliance is moving toward mandatory dev-screening, and BBPS is the warmest billing channel. Your job is to sign 3 pilot schools and the BBPS MOU this quarter.",
      },
      budgetMonthlyCents: 20_000,
      lastHeartbeatAt: new Date(NOW - 4 * HOUR_MS),
    })
    .returning();

  if (!lwCEO) throw new Error("Little Wins CEO insert failed");

  const [lwOps] = await db
    .insert(agents)
    .values({
      companyId: littleWins.id,
      name: "Reva",
      role: "head_of_ops",
      title: "Ops & School Partnerships — Little Wins",
      icon: "🏫",
      reportsTo: lwCEO.id,
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4-6",
        maxTurnsPerRun: 20,
        dangerouslySkipPermissions: true,
        promptTemplate:
          "You are Reva, Ops at Little Wins. You own school onboarding, screening-session ops, and parent communication. The buyer is the principal; the user is the parent.",
      },
      budgetMonthlyCents: 12_000,
      lastHeartbeatAt: new Date(NOW - 2 * HOUR_MS),
    })
    .returning();

  if (!lwOps) throw new Error("Little Wins Ops insert failed");

  // Minimal narrative per the dispatcher: memory + approvals + 1 integration
  await db.insert(companyMemory).values([
    {
      companyId: littleWins.id,
      kind: "founder_note",
      title: "BBPS is the warmest lead — start with billing, not screening",
      body:
        "Counterintuitive finding: school principals say 'we need screening'. School accountants say 'we need BBPS payments'. Accountants close faster. Lead with the BBPS billing integration; screening is the upsell.",
      topic: "wedge",
      occurredAt: new Date(NOW - 18 * DAY_MS),
      pinned: true,
      source: "manual",
    },
    {
      companyId: littleWins.id,
      kind: "experiment_outcome",
      title: "CBSE compliance panel vs. private-school DMs: 9x close rate",
      body:
        "Outreach experiment: private schools answered 'what's in it for the principal?'. CBSE-affiliated schools responded to the compliance memo. 9x higher close rate. Focus is CBSE-only.",
      topic: "gtm",
      occurredAt: new Date(NOW - 26 * DAY_MS),
      pinned: false,
      source: "manual",
    },
    {
      companyId: littleWins.id,
      kind: "milestone",
      title: "First 3 CBSE pilots verbally committed",
      body:
        "Three Delhi-NCR CBSE schools verbally committed to a 3-month pilot. Formal MOUs in flight.",
      topic: "growth",
      occurredAt: new Date(NOW - 6 * DAY_MS),
      pinned: false,
      source: "manual",
    },
  ]);

  await db.insert(approvals).values([
    {
      companyId: littleWins.id,
      type: "partnership",
      requestedByAgentId: lwCEO.id,
      status: "pending",
      payload: {
        title: "BBPS biller onboarding — 30-day fast-track",
        rationale:
          "BBPS ops director offered to fast-track our biller onboarding if we commit to 3 pilot schools by June. Legal review + $8K integration partner fee required.",
        amount_usd: 8_000,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(NOW - 2 * DAY_MS),
      updatedAt: new Date(NOW - 2 * DAY_MS),
    },
    {
      companyId: littleWins.id,
      type: "hire_request",
      requestedByAgentId: lwCEO.id,
      status: "approved",
      payload: {
        title: "Hire school-onboarding lead (Delhi)",
        rationale:
          "Reva's pipeline is saturating. Need a Delhi-based lead with CBSE network for the next 10 pilots.",
        amount_usd: 22_000,
      },
      decisionNote: "Approved — principal outreach is the bottleneck.",
      decidedByUserId: "local-board",
      decidedAt: new Date(NOW - 4 * DAY_MS),
      createdAt: new Date(NOW - 7 * DAY_MS),
      updatedAt: new Date(NOW - 4 * DAY_MS),
    },
  ]);

  const [lwSlack] = await db
    .insert(integrations)
    .values({
      companyId: littleWins.id,
      kind: "slack",
      status: "connected",
      keyHint: "1aB3",
      encryptedApiKey: null,
      config: {
        team_id: "T01LTLWIN",
        team_name: "Little Wins",
        default_channel: "C01SCHOOLS",
      },
      connectedAt: new Date(NOW - 30 * DAY_MS),
    })
    .returning();

  if (lwSlack) {
    await db.insert(integrationData).values([
      {
        companyId: littleWins.id,
        integrationId: lwSlack.id,
        kind: "slack.channels.summary",
        payload: { total_channels: 6, active_last_7d: 4, primary: "#schools" },
        fetchedAt: new Date(NOW - HOUR_MS),
      },
      {
        companyId: littleWins.id,
        integrationId: lwSlack.id,
        kind: "slack.messages.sample",
        payload: {
          messages: [
            {
              user: "Anvi",
              channel: "#bbps",
              text: "BBPS ops dir on the phone right now — they want 3 pilot schools signed by June for the fast-track.",
              ts_minutes_ago: 22,
            },
          ],
        },
        fetchedAt: new Date(NOW - HOUR_MS),
      },
    ]);
  }

  // Minor activity log entries
  await db.insert(activityLog).values([
    {
      companyId: littleWins.id,
      actorType: "agent",
      actorId: lwCEO.id,
      agentId: lwCEO.id,
      action: "lead.warm",
      entityType: "partnership",
      entityId: randomUUID(),
      details: {
        note: "BBPS ops dir call — fast-track offer on the table.",
      },
      createdAt: new Date(NOW - 6 * HOUR_MS),
    },
    {
      companyId: littleWins.id,
      actorType: "agent",
      actorId: lwOps.id,
      agentId: lwOps.id,
      action: "pilot.verbal",
      entityType: "deal",
      entityId: randomUUID(),
      details: {
        note: "DPS Noida verbally committed to 3-month pilot. MOU drafting.",
      },
      createdAt: new Date(NOW - 28 * HOUR_MS),
    },
  ]);

  console.log(
    "[seed-narrative] ✓ Added experimental 4th company 'Little Wins' (marked experimental).",
  );
} else {
  console.log(
    "[seed-narrative] • Little Wins already present — skipping experimental company seed.",
  );
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[seed-narrative] ✓ Narrative layer complete.");
console.log("  • company_memory per company:");
console.log(`    - Acme Robotics ${memorySeeds.filter((m) => m.companyId === acme.id).length}`);
console.log(`    - Beta Labs     ${memorySeeds.filter((m) => m.companyId === beta.id).length}`);
console.log(`    - Demo Corp     ${memorySeeds.filter((m) => m.companyId === demoCorp.id).length}`);
console.log("  • approvals added per company:");
console.log(`    - Acme Robotics ${approvalSeeds.filter((a) => a.companyId === acme.id).length}`);
console.log(`    - Beta Labs     ${approvalSeeds.filter((a) => a.companyId === beta.id).length}`);
console.log(`    - Demo Corp     ${approvalSeeds.filter((a) => a.companyId === demoCorp.id).length}`);
console.log(`  • integrations connected: ${integrationRecords.length} (3 per main company)`);
console.log(`  • integration_data rows:  ${dataInserts.length}`);
process.exit(0);
