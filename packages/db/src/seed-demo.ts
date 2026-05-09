/**
 * Demo seed — three generic placeholder companies (NOT real customer data).
 *
 *   1. Acme Robotics    — pre-seed AI/robotics research
 *   2. Beta Labs        — live consumer prediction marketplace
 *   3. Demo Corp        — bootstrapped B2B SaaS (category creator)
 *
 * Inserts data for demo / development / testing ONLY. Every row gets
 * `companies.is_demo = true` so it can be filtered out of real metrics
 * and purged with a single DELETE.
 *
 * This script REFUSES to run unless `FOUNDEROS_SEED_DEMO=1` is set in the
 * environment. That gate is the buyer-trust backstop: a buyer pointing this
 * script at their tenant by accident (or following stale instructions) will
 * see a clear refusal instead of synthetic companies appearing in their data.
 *
 * Run:
 *   FOUNDEROS_SEED_DEMO=1 \
 *   DATABASE_URL=postgres://founderos:founderos@127.0.0.1:54329/founderos \
 *     pnpm --filter @founderos/db exec tsx src/seed-demo.ts
 *
 * See docs/runbooks/seed-demo.md for safe usage.
 */
import { createDb } from "./client.js";
import {
  companies,
  agents,
  goals,
  projects,
  issues,
  activityLog,
} from "./schema/index.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

if (process.env.FOUNDEROS_SEED_DEMO !== "1") {
  console.error(
    "[seed-demo] Refusing to run: this script inserts demo-only data into " +
      "the configured DATABASE_URL. Set FOUNDEROS_SEED_DEMO=1 to confirm you " +
      "are pointing at a development/test database, never production. " +
      "See docs/runbooks/seed-demo.md for safe usage.",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

console.log(
  "[seed-demo] Seeding 3 demo companies (Acme Robotics / Beta Labs / Demo Corp)…",
);

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
import type { CompanyMetrics } from "./schema/companies.js";

const mkCompany = async (config: {
  name: string;
  description: string;
  issuePrefix: string;
  budgetUsd: number;
  brandColor?: string;
  metrics?: CompanyMetrics;
}) => {
  const [c] = await db
    .insert(companies)
    .values({
      name: config.name,
      description: config.description,
      issuePrefix: config.issuePrefix,
      status: "active",
      budgetMonthlyCents: config.budgetUsd * 100,
      brandColor: config.brandColor ?? null,
      metrics: config.metrics ?? {},
      isDemo: true,
    })
    .returning();
  return c!;
};

type AgentSeed = {
  name: string;
  role: string;
  title: string;
  icon?: string;
  reportsTo?: string;
  budgetUsd?: number;
  status?: string;
  capabilities: string;
  systemPrompt: string;
};

const mkAgent = async (companyId: string, s: AgentSeed) => {
  const [a] = await db
    .insert(agents)
    .values({
      companyId,
      name: s.name,
      role: s.role,
      title: s.title,
      icon: s.icon ?? "🤖",
      reportsTo: s.reportsTo,
      status: s.status ?? "idle",
      capabilities: s.capabilities,
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-6",
        maxTurnsPerRun: 40,
        dangerouslySkipPermissions: true,
        promptTemplate: s.systemPrompt,
      },
      budgetMonthlyCents: (s.budgetUsd ?? 120) * 100,
      lastHeartbeatAt: new Date(Date.now() - Math.random() * 3_600_000),
    })
    .returning();
  return a!;
};

const mkGoal = async (config: {
  companyId: string;
  title: string;
  description: string;
  ownerAgentId: string;
  status?: string;
}) => {
  const [g] = await db
    .insert(goals)
    .values({
      companyId: config.companyId,
      title: config.title,
      description: config.description,
      level: "company",
      status: config.status ?? "active",
      ownerAgentId: config.ownerAgentId,
    })
    .returning();
  return g!;
};

const mkProject = async (config: {
  companyId: string;
  goalId: string;
  name: string;
  description: string;
  leadAgentId: string;
  status?: string;
}) => {
  const [p] = await db
    .insert(projects)
    .values({
      companyId: config.companyId,
      goalId: config.goalId,
      name: config.name,
      description: config.description,
      status: config.status ?? "in_progress",
      leadAgentId: config.leadAgentId,
    })
    .returning();
  return p!;
};

const allIssueSeeds: Array<{
  companyId: string;
  projectId: string;
  goalId: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done";
  priority: "low" | "medium" | "high" | "urgent";
  assigneeAgentId?: string;
  createdByAgentId?: string;
}> = [];

const allActivityRows: Array<typeof activityLog.$inferInsert> = [];

// ══════════════════════════════════════════════════════════════════════════
// 1. Acme Robotics — pre-seed AI/robotics research (demo placeholder)
// ══════════════════════════════════════════════════════════════════════════
const acme = await mkCompany({
  name: "Acme Robotics",
  description:
    "Self-improving AI agents (demo data). Pre-seed, $250K raised. Research-lean, eval-first. Target: sign 5 paying design partners at frontier labs before the seed round.",
  issuePrefix: "ACR",
  budgetUsd: 1800,
  brandColor: "#6366f1",
  metrics: {
    stage: "Pre-seed",
    tagline: "Pre-seed AI research · self-improving agents · $250K runway capital",
    fundingRaisedCents: 25_000_000, // $250K
    customersSigned: 3, // design partners
    pipelineCount: 6,
    monthlyBurnCents: 1_800_000, // $18K
    runwayMonths: 11,
    nextMilestoneLabel: "Seed round in 8 mo",
    keyAccounts: ["Partner Lab A (DP)", "Partner Lab B (scoping)", "Partner Lab C (scoping)"],
    deltas: {
      fundingRaised: { dir: "up", text: "pre-seed closed" },
      customersSigned: { dir: "up", text: "+2 in scoping" },
      monthlyBurn: { dir: "flat", text: "lean" },
      runway: { dir: "down", text: "tight" },
    },
  },
});

const acmeCEO = await mkAgent(acme.id, {
  name: "Nova",
  role: "ceo",
  title: "CEO — Acme Robotics",
  icon: "🧭",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Sets research agenda, writes thesis papers, owns fundraise narrative, runs weekly all-hands. Talks to labs + investors.",
  systemPrompt:
    "You are Nova, the CEO of Acme Robotics (a demo-tenant placeholder). We've raised a $250K pre-seed. The thesis: AI agents improve fastest when they measure themselves. Your job: set the research agenda, write the public thesis, sign 3 more design partners, and raise a $3M seed in the next 8 months. Be sharp, opinionated, first-principles.",
});

const acmeCoS = await mkAgent(acme.id, {
  name: "Sage",
  role: "chief_of_staff",
  title: "Chief of Staff — Acme Robotics",
  icon: "🗂️",
  reportsTo: acmeCEO.id,
  budgetUsd: 200,
  status: "active",
  capabilities:
    "Runs Nova's calendar, drafts weekly updates, converts decisions into owned tasks, clears inbox, prepares fundraise materials.",
  systemPrompt:
    "You are Sage, Chief of Staff at Acme Robotics. You translate Nova's decisions into owned tasks, clear the inbox, and keep the company's weekly rhythm on track. You write like a consigliere — concise, honest, no fluff.",
});

const acmeCTO = await mkAgent(acme.id, {
  name: "Kepler",
  role: "cto",
  title: "CTO & Head of Research Eng — Acme Robotics",
  icon: "🔬",
  reportsTo: acmeCEO.id,
  budgetUsd: 400,
  status: "active",
  capabilities:
    "Owns the eval harness architecture, the agent improvement loop, and all research engineering. Shipping bar is reproducibility.",
  systemPrompt:
    "You are Kepler, CTO of Acme Robotics. You own the eval harness and the self-improvement loop. Every claim we make must be reproducible. Engineering hires go through you. Your bar is: can another lab replicate this in 2 weeks?",
});

const acmeEvals = await mkAgent(acme.id, {
  name: "Vera",
  role: "head_of_evals",
  title: "Head of Evals — Acme Robotics",
  icon: "📏",
  reportsTo: acmeCTO.id,
  budgetUsd: 300,
  status: "active",
  capabilities:
    "Designs rubrics, builds graders, runs benchmark suites (SWE-bench, AgentBench, MMLU-Pro), writes eval papers.",
  systemPrompt:
    "You are Vera, Head of Evals at Acme Robotics. You design and defend the rubrics that measure agent quality. You treat vibes as a smell. You ship a new eval benchmark every two weeks and publish the methodology publicly.",
});

const acmeGrowth = await mkAgent(acme.id, {
  name: "Atlas",
  role: "head_of_growth",
  title: "Growth & Developer Relations — Acme Robotics",
  icon: "📈",
  reportsTo: acmeCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Runs the waitlist funnel, owns dev-rel, speaks at AI conferences, manages the blog cadence, runs the Discord.",
  systemPrompt:
    "You are Atlas, Growth/DevRel at Acme Robotics. Our buyer is a research engineer at a frontier lab. You write for them. You get us from 500 → 10,000 waitlist signups by shipping a killer benchmark + essay every two weeks.",
});

const acmeContent = await mkAgent(acme.id, {
  name: "Indra",
  role: "head_of_content",
  title: "Technical Writer — Acme Robotics",
  icon: "✍️",
  reportsTo: acmeGrowth.id,
  budgetUsd: 140,
  status: "idle",
  capabilities:
    "Writes the benchmark blog posts, ghostwrites Nova's essays, maintains the docs. LaTeX for papers.",
  systemPrompt:
    "You are Indra, technical writer at Acme Robotics. Your voice is precise, specific, unhyped. Every blog post ends with: the exact experiment, the numbers, the code to reproduce.",
});

const acmeBD = await mkAgent(acme.id, {
  name: "Bodhi",
  role: "head_of_bd",
  title: "Biz Dev & Partnerships — Acme Robotics",
  icon: "🤝",
  reportsTo: acmeCEO.id,
  budgetUsd: 160,
  status: "active",
  capabilities:
    "Runs outreach to AI labs, books technical design-partner calls, drafts partnership MOUs.",
  systemPrompt:
    "You are Bodhi, BD at Acme Robotics. Your targets are applied-research leads at frontier labs. You book intro calls, qualify fit, and move 5 of them to paying design partners. You never cold-pitch — you offer value (a custom benchmark on their agents) first.",
});

// Acme Robotics — goals, projects, issues
const acmeGoalEvals = await mkGoal({
  companyId: acme.id,
  title: "Ship eval-harness v1 (public, open-source) by end of month",
  description: "Public repo, reproducible scripts, 3 reference benchmarks. Target 1k GitHub stars in first 30 days.",
  ownerAgentId: acmeCTO.id,
});

const acmeGoalPapers = await mkGoal({
  companyId: acme.id,
  title: "Publish 3 benchmark papers on arXiv this quarter",
  description: "Each paper ships alongside a blog post + reproducible notebook. Targets: eval method, scaling, self-critique.",
  ownerAgentId: acmeEvals.id,
});

const acmeGoalPartners = await mkGoal({
  companyId: acme.id,
  title: "Land 5 design partners at frontier AI labs",
  description: "Paying design-partner contracts at $2k–5k/mo. Access to their agent logs in exchange for custom eval reports.",
  ownerAgentId: acmeBD.id,
});

const acmeGoalWaitlist = await mkGoal({
  companyId: acme.id,
  title: "Grow waitlist to 10k research engineers",
  description: "From 500 today. Driven by 2x/month technical blog posts and conference talks.",
  ownerAgentId: acmeGrowth.id,
});

const acmeProjHarness = await mkProject({ companyId: acme.id, goalId: acmeGoalEvals.id, name: "Eval-harness v1 (open source)", description: "Reproducible Python harness + adapters for claude/gpt/gemini. CLI + pytest plugin.", leadAgentId: acmeCTO.id });
const acmeProjBench = await mkProject({ companyId: acme.id, goalId: acmeGoalPapers.id, name: "SWE-bench-Live + agentic dynamics paper", description: "Extend SWE-bench with live repos. Measure how agent performance decays on fresh bugs.", leadAgentId: acmeEvals.id });
const acmeProjDP = await mkProject({ companyId: acme.id, goalId: acmeGoalPartners.id, name: "Lab design-partner pipeline", description: "30 target companies, 10 first calls, 5 signed MoUs at $2k–5k/mo.", leadAgentId: acmeBD.id });
const acmeProjBlog = await mkProject({ companyId: acme.id, goalId: acmeGoalWaitlist.id, name: "Technical blog cadence (bi-weekly)", description: "Benchmark + essay every two weeks. Tied to waitlist signups.", leadAgentId: acmeGrowth.id });

allIssueSeeds.push(
  { companyId: acme.id, projectId: acmeProjHarness.id, goalId: acmeGoalEvals.id, title: "Adapter abstraction for claude/gpt/gemini", description: "One interface, three backends. Cover streaming + tool-use.", status: "in_progress", priority: "urgent", assigneeAgentId: acmeCTO.id, createdByAgentId: acmeCTO.id },
  { companyId: acme.id, projectId: acmeProjHarness.id, goalId: acmeGoalEvals.id, title: "Ship pytest plugin for eval-harness", description: "`pytest --eval` flag runs all benchmarks as test cases.", status: "in_progress", priority: "high", assigneeAgentId: acmeCTO.id, createdByAgentId: acmeEvals.id },
  { companyId: acme.id, projectId: acmeProjHarness.id, goalId: acmeGoalEvals.id, title: "README + quickstart", description: "30-second install-to-first-eval story.", status: "todo", priority: "high", assigneeAgentId: acmeContent.id, createdByAgentId: acmeGrowth.id },
  { companyId: acme.id, projectId: acmeProjBench.id, goalId: acmeGoalPapers.id, title: "SWE-bench-Live data collection pipeline", description: "Daily scrape of 200 repos with labeled bugs.", status: "in_progress", priority: "high", assigneeAgentId: acmeEvals.id, createdByAgentId: acmeCTO.id },
  { companyId: acme.id, projectId: acmeProjBench.id, goalId: acmeGoalPapers.id, title: "Paper draft v1 (Methodology section)", description: "Define the live-bench protocol, inclusion criteria, grader.", status: "todo", priority: "medium", assigneeAgentId: acmeEvals.id, createdByAgentId: acmeCEO.id },
  { companyId: acme.id, projectId: acmeProjDP.id, goalId: acmeGoalPartners.id, title: "30-account target list (applied research leads)", description: "Frontier labs, applied-eval and agent-team leads.", status: "done", priority: "high", assigneeAgentId: acmeBD.id, createdByAgentId: acmeCEO.id },
  { companyId: acme.id, projectId: acmeProjDP.id, goalId: acmeGoalPartners.id, title: "Book 10 intro calls this fortnight", description: "30-min, offer custom benchmark of their latest agent as hook.", status: "in_progress", priority: "urgent", assigneeAgentId: acmeBD.id, createdByAgentId: acmeCEO.id },
  { companyId: acme.id, projectId: acmeProjDP.id, goalId: acmeGoalPartners.id, title: "Draft design-partner MoU template", description: "Monthly fee + log access + joint blog post clause.", status: "in_review", priority: "medium", assigneeAgentId: acmeCoS.id, createdByAgentId: acmeBD.id },
  { companyId: acme.id, projectId: acmeProjBlog.id, goalId: acmeGoalWaitlist.id, title: "Essay: 'The eval is the product'", description: "Nova's thesis post. Target: HN front page, 20 comments.", status: "in_review", priority: "high", assigneeAgentId: acmeContent.id, createdByAgentId: acmeCEO.id },
  { companyId: acme.id, projectId: acmeProjBlog.id, goalId: acmeGoalWaitlist.id, title: "Blog: 'How frontier models score on SWE-bench-Live'", description: "Benchmark + analysis + data drop.", status: "in_progress", priority: "high", assigneeAgentId: acmeEvals.id, createdByAgentId: acmeGrowth.id },
);

// ══════════════════════════════════════════════════════════════════════════
// 2. Beta Labs — live consumer prediction marketplace (demo placeholder)
// ══════════════════════════════════════════════════════════════════════════
const beta = await mkCompany({
  name: "Beta Labs",
  description:
    "Live P2P prediction market — top-flight European football leagues only (demo data). $2.5M Series Seed raised. 42K MAU, $1.8M monthly GMV, take-rate 3.2%. Skill-game regulatory framing, compliant PSP live.",
  issuePrefix: "BTA",
  budgetUsd: 9400,
  brandColor: "#10b981",
  metrics: {
    stage: "Live · Series Seed",
    tagline: "Live football prediction market · top European leagues · $2.5M funded",
    fundingRaisedCents: 250_000_000, // $2.5M
    gmvMonthlyCents: 180_000_000, // $1.8M
    mauCount: 42_100,
    monthlyBurnCents: 9_400_000, // $94K
    runwayMonths: 22,
    nextMilestoneLabel: "Series A Q4 2026",
    keyAccounts: ["42K MAU", "Top-flight markets", "PSP integrated"],
    deltas: {
      mau: { dir: "up", text: "+18% MoM" },
      gmvMonthly: { dir: "up", text: "+22% MoM" },
      monthlyBurn: { dir: "flat", text: "stable" },
      runway: { dir: "up", text: "post-seed" },
    },
  },
});

const betaCEO = await mkAgent(beta.id, {
  name: "Arjun",
  role: "ceo",
  title: "CEO — Beta Labs",
  icon: "⚽",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Owns the skill-game legal thesis, board updates, market design, liquidity strategy, fundraise narrative.",
  systemPrompt:
    "You are Arjun, CEO of Beta Labs (a demo-tenant placeholder). We ship prediction markets for top European football leagues only — that narrow focus is our moat. We've raised $2.5M and we're live with 42K MAU and $1.8M monthly GMV. Your job: scale MAU to 200K by end of knockout rounds, defend the skill-game regulatory position, and position for Series A in Q4.",
});

const betaCoS = await mkAgent(beta.id, {
  name: "Riya",
  role: "chief_of_staff",
  title: "Chief of Staff — Beta Labs",
  icon: "🗂️",
  reportsTo: betaCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Runs Arjun's calendar, handles regulatory correspondence, preps investor updates, owns the weekly business review.",
  systemPrompt:
    "You are Riya, Chief of Staff at Beta Labs. You handle regulator correspondence, investor updates, and the weekly biz review. Every regulator email is filed as discovery. You prep Arjun for every matchday call with the data feed + liquidity team.",
});

const betaCTO = await mkAgent(beta.id, {
  name: "Dev",
  role: "cto",
  title: "CTO — Beta Labs",
  icon: "🔧",
  reportsTo: betaCEO.id,
  budgetUsd: 1200,
  status: "active",
  capabilities:
    "Owns the real-time matching engine, sports-data feed integration, settlement, risk controls, and match-day reliability.",
  systemPrompt:
    "You are Dev, CTO of Beta Labs. Match-day reliability is the product. You own the real-time matching engine, official live-data integration, and settlement pipeline. Our SLA: order-book responsive within 200ms of a goal event. Manipulation detection is not optional — you kill markets that smell wrong.",
});

const betaMarkets = await mkAgent(beta.id, {
  name: "Meher",
  role: "head_of_markets",
  title: "Head of Markets — Beta Labs",
  icon: "🎯",
  reportsTo: betaCEO.id,
  budgetUsd: 450,
  status: "active",
  capabilities:
    "Curates which fixtures list which markets, sets opening liquidity, monitors anomalies live, sets limits.",
  systemPrompt:
    "You are Meher, Head of Markets at Beta Labs. For every fixture you list the right markets (1X2, over/under, BTTS, first scorer, corners, cards, clean sheet). You set opening liquidity from the 3-year model + live adjust using the sports data feed + our in-house EV model. Kill any market showing manipulation signals within 90 seconds.",
});

const betaCompliance = await mkAgent(beta.id, {
  name: "Anaya",
  role: "head_of_compliance",
  title: "Head of Compliance — Beta Labs",
  icon: "⚖️",
  reportsTo: betaCEO.id,
  budgetUsd: 360,
  status: "active",
  capabilities:
    "Tracks state-by-state gaming law, KYC/AML policy, PSP compliance, responsible-gaming limits.",
  systemPrompt:
    "You are Anaya, Head of Compliance at Beta Labs. We operate on the skill-game framework — every decision you make must hold in a hearing. You run KYC/AML, file quarterly suspicious-transaction returns, enforce state-level geo-blocks, and defend the PSP relationship. Responsible-gaming limits are inviolable: daily deposit caps, loss-chase cooling-off, self-exclusion honored forever.",
});

const betaGrowth = await mkAgent(beta.id, {
  name: "Karthik",
  role: "head_of_growth",
  title: "Head of Growth — Beta Labs",
  icon: "📈",
  reportsTo: betaCEO.id,
  budgetUsd: 800,
  status: "active",
  capabilities:
    "Owns CAC, referral loops, matchday acquisition playbooks, partnerships with football creators + fantasy communities.",
  systemPrompt:
    "You are Karthik, Head of Growth at Beta Labs. Top-flight kickoff weekends + midweek European nights are our Super Bowls every week. You own CAC (currently ₹220, target <₹180), referral loops, paid on Meta + YT, and creator partnerships with football fan communities. Every matchday the acquisition curve should spike.",
});

const betaContent = await mkAgent(beta.id, {
  name: "Zara",
  role: "head_of_content",
  title: "Head of Content — Beta Labs",
  icon: "📝",
  reportsTo: betaGrowth.id,
  budgetUsd: 260,
  status: "active",
  capabilities:
    "Writes match previews + post-match wraps, explainer videos on market mechanics, Reels/Shorts scripts for matchdays.",
  systemPrompt:
    "You are Zara, Head of Content at Beta Labs. Your voice is football-fluent — you know the difference between a low block and a mid block, between expected goals and expected threat. Every matchday gets a pre-match preview (stats + markets) and a post-match wrap (what settled, what moved). Short-form video is the primary channel.",
});

const betaOps = await mkAgent(beta.id, {
  name: "Ishaan",
  role: "head_of_ops",
  title: "Head of Ops & Support — Beta Labs",
  icon: "🛠️",
  reportsTo: betaCEO.id,
  budgetUsd: 320,
  status: "active",
  capabilities:
    "Owns KYC onboarding queue, withdrawal approvals, match-day support SLA, dispute resolution, responsible-gaming enforcement.",
  systemPrompt:
    "You are Ishaan, Head of Ops at Beta Labs. Match-day SLA: support <30 min, withdrawal <2 min, disputes <24h. You run the responsible-gaming enforcement (deposit limits, cooling-off, self-exclusion). When a user loses money and writes in angry, you lead with empathy and fact — you're the reason they stay a customer.",
});

// Beta Labs — goals, projects, issues
const betaGoalScale = await mkGoal({
  companyId: beta.id,
  title: "Scale to 200K MAU by end of European knockout rounds (May)",
  description: "From 42K today. Driven by matchday acquisition + knockout-round hype + creator partnerships. Hold CAC under ₹200.",
  ownerAgentId: betaCEO.id,
});

const betaGoalLiquidity = await mkGoal({
  companyId: beta.id,
  title: "Natural liquidity on top-50 fixture markets",
  description: "End market-maker subsidies on main markets (1X2, O/U 2.5, BTTS). Organic order flow keeps spreads <2%.",
  ownerAgentId: betaMarkets.id,
});

const betaGoalCompliance = await mkGoal({
  companyId: beta.id,
  title: "Hold zero compliance incidents through the knockout rounds",
  description: "Q2 quarterly filing clean, zero state-level violations, responsible-gaming policy enforcement 100%.",
  ownerAgentId: betaCompliance.id,
});

const betaGoalSeriesA = await mkGoal({
  companyId: beta.id,
  title: "Series A lead commitment by Q4",
  description: "Target $12M at $60M post. Lead thesis: global football prediction markets. 3 term sheets by Oct.",
  ownerAgentId: betaCEO.id,
});

const betaProjMatchday = await mkProject({ companyId: beta.id, goalId: betaGoalScale.id, name: "Matchday ops playbook", description: "T-48h staff-up → T-2h market reprice → live ops → settlement → post-match wrap. Same playbook every match.", leadAgentId: betaOps.id });
const betaProjEngine = await mkProject({ companyId: beta.id, goalId: betaGoalLiquidity.id, name: "Matching engine v3 + live data integration", description: "Sub-200ms market response to goal events. Official feed, not scraped.", leadAgentId: betaCTO.id });
const betaProjCreators = await mkProject({ companyId: beta.id, goalId: betaGoalScale.id, name: "Football creator partnerships", description: "25 creators (100K–2M followers) covering top European football — revenue-share + matchday drops.", leadAgentId: betaGrowth.id });
const betaProjRG = await mkProject({ companyId: beta.id, goalId: betaGoalCompliance.id, name: "Responsible-gaming + KYC v2", description: "Hard daily deposit caps, cooling-off periods, self-exclusion registry, Q2 quarterly filing prep.", leadAgentId: betaCompliance.id });
const betaProjFundraise = await mkProject({ companyId: beta.id, goalId: betaGoalSeriesA.id, name: "Series A data room + pipeline", description: "30 target funds, 12 warm intros, 6 first meetings, 3 term sheets targeted by Oct.", leadAgentId: betaCEO.id });

allIssueSeeds.push(
  // Matchday ops
  { companyId: beta.id, projectId: betaProjMatchday.id, goalId: betaGoalScale.id, title: "Matchday runbook — marquee weekend fixture", description: "Marquee fixture Saturday 5:30pm IST. Expected 3x normal GMV. Double-up support coverage.", status: "in_progress", priority: "urgent", assigneeAgentId: betaOps.id, createdByAgentId: betaCEO.id },
  { companyId: beta.id, projectId: betaProjMatchday.id, goalId: betaGoalScale.id, title: "Post-match wrap automation", description: "Auto-generate results Reel within 10 min of final whistle — stats + 'markets that moved'.", status: "in_review", priority: "high", assigneeAgentId: betaContent.id, createdByAgentId: betaGrowth.id },
  { companyId: beta.id, projectId: betaProjMatchday.id, goalId: betaGoalScale.id, title: "Knockout-round QF first-leg market list (8 fixtures)", description: "Meher sets O/U lines, first-scorer odds, ties-to-aggregate. 48h before each match.", status: "todo", priority: "urgent", assigneeAgentId: betaMarkets.id, createdByAgentId: betaCEO.id },

  // Engine + data feed
  { companyId: beta.id, projectId: betaProjEngine.id, goalId: betaGoalLiquidity.id, title: "Live data feed integration v1", description: "Replace scraped ticker with official feed. Events: goal, VAR, card, sub, period-end.", status: "in_progress", priority: "urgent", assigneeAgentId: betaCTO.id, createdByAgentId: betaCTO.id },
  { companyId: beta.id, projectId: betaProjEngine.id, goalId: betaGoalLiquidity.id, title: "Sub-200ms market response on goal events", description: "Measured end-to-end: feed → book suspension → quote update → re-open.", status: "todo", priority: "urgent", assigneeAgentId: betaCTO.id, createdByAgentId: betaCEO.id },
  { companyId: beta.id, projectId: betaProjEngine.id, goalId: betaGoalLiquidity.id, title: "Market-maker subsidy wind-down plan", description: "Week-by-week plan to pull subsidies from top-50 markets without widening spreads.", status: "in_review", priority: "high", assigneeAgentId: betaMarkets.id, createdByAgentId: betaCEO.id },

  // Creator partnerships
  { companyId: beta.id, projectId: betaProjCreators.id, goalId: betaGoalScale.id, title: "Sign top-3 football creator package", description: "Revenue-share + matchday exclusive with stats-led creators in target markets.", status: "in_progress", priority: "urgent", assigneeAgentId: betaGrowth.id, createdByAgentId: betaCEO.id },
  { companyId: beta.id, projectId: betaProjCreators.id, goalId: betaGoalScale.id, title: "Football creator list (25 names)", description: "Reddit mod teams + IG fanclub admins covering target leagues.", status: "done", priority: "high", assigneeAgentId: betaGrowth.id, createdByAgentId: betaGrowth.id },
  { companyId: beta.id, projectId: betaProjCreators.id, goalId: betaGoalScale.id, title: "Creator contract + rev-share template", description: "18% rev-share, 12-mo exclusivity on prediction-market content, approvals flow.", status: "in_progress", priority: "medium", assigneeAgentId: betaCoS.id, createdByAgentId: betaGrowth.id },

  // Compliance + RG
  { companyId: beta.id, projectId: betaProjRG.id, goalId: betaGoalCompliance.id, title: "Q2 quarterly suspicious-transaction filing", description: "Compile suspicious-transaction nil-return + KYC exception log. Deadline June 15.", status: "in_progress", priority: "urgent", assigneeAgentId: betaCompliance.id, createdByAgentId: betaCompliance.id },
  { companyId: beta.id, projectId: betaProjRG.id, goalId: betaGoalCompliance.id, title: "Hard deposit caps: ₹10K daily, ₹50K weekly (default)", description: "Enforced server-side. Users can lower, cannot raise without 7-day cooling-off.", status: "in_review", priority: "high", assigneeAgentId: betaCTO.id, createdByAgentId: betaCompliance.id },
  { companyId: beta.id, projectId: betaProjRG.id, goalId: betaGoalCompliance.id, title: "Self-exclusion registry — cross-platform hash", description: "Share hashed identity token with industry registry. Re-entry blocked permanently once enrolled.", status: "todo", priority: "high", assigneeAgentId: betaCompliance.id, createdByAgentId: betaCompliance.id },

  // Fundraise
  { companyId: beta.id, projectId: betaProjFundraise.id, goalId: betaGoalSeriesA.id, title: "Series A memo v1 — 12 pages", description: "Problem → wedge (top European leagues only, narrow focus) → traction → team → $12M ask.", status: "in_progress", priority: "high", assigneeAgentId: betaCEO.id, createdByAgentId: betaCEO.id },
  { companyId: beta.id, projectId: betaProjFundraise.id, goalId: betaGoalSeriesA.id, title: "Warm intro list — 30 target funds", description: "Consumer + marketplace specialists. Mix of regional + global.", status: "done", priority: "high", assigneeAgentId: betaCEO.id, createdByAgentId: betaCEO.id },
  { companyId: beta.id, projectId: betaProjFundraise.id, goalId: betaGoalSeriesA.id, title: "Cohort retention dashboard — 9-month trails", description: "Monthly cohort → D1/D7/D30/D90 retention, GMV per cohort. Fundraise critical.", status: "in_progress", priority: "high", assigneeAgentId: betaCTO.id, createdByAgentId: betaCEO.id },
);

// ══════════════════════════════════════════════════════════════════════════
// 3. Demo Corp — bootstrapped B2B SaaS / category creator (demo placeholder)
// ══════════════════════════════════════════════════════════════════════════
const demo = await mkCompany({
  name: "Demo Corp",
  description:
    "Generative-engine optimization platform — 'SEO for LLM search' (demo data). Help brands win citations inside ChatGPT, Claude, Perplexity, Gemini. Bootstrapped + raising first round. Closing 40 pilot customers (11 signed @ ~$32K avg ACV, 29 in flight).",
  issuePrefix: "DMO",
  budgetUsd: 3600,
  brandColor: "#f59e0b",
  metrics: {
    stage: "Bootstrapped · Raising",
    tagline: "GEO/AEO category creator · 40 pilots closing · raising first round",
    fundingRaisedCents: 0, // bootstrapped
    pipelineCount: 40, // 40 pilots in flight
    customersSigned: 11, // 11 signed contracts
    pipelineCents: 35_200_000, // $352K signed weighted ACV
    monthlyBurnCents: 3_600_000, // $36K
    nextMilestoneLabel: "First round in progress",
    keyAccounts: ["DTC pilot A", "DTC pilot B", "+38 pilots in flight"],
    deltas: {
      pipeline: { dir: "up", text: "+12 WoW" },
      customersSigned: { dir: "up", text: "+3 MoM" },
      monthlyBurn: { dir: "flat", text: "bootstrapped" },
    },
  },
});

const demoCEO = await mkAgent(demo.id, {
  name: "Rohan",
  role: "ceo",
  title: "CEO — Demo Corp",
  icon: "🌐",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Creates the GEO category. Writes the definitional essays. Owns enterprise sales + the fundraise story.",
  systemPrompt:
    "You are Rohan, CEO of Demo Corp (a demo-tenant placeholder). You're creating a new category: GEO/AEO — the optimization discipline for LLM search. Your writing creates the market. Your sales closes the first 10 enterprise accounts. You think in 'who will cite this in 5 years' terms.",
});

const demoCoS = await mkAgent(demo.id, {
  name: "Neha",
  role: "chief_of_staff",
  title: "Chief of Staff — Demo Corp",
  icon: "🗂️",
  reportsTo: demoCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Owns the exec cadence, prepares board decks, manages Rohan's inbox, runs the weekly pipeline review.",
  systemPrompt:
    "You are Neha, Chief of Staff at Demo Corp. You run the exec cadence, prep board decks, and own the weekly pipeline review. You're the glue between Rohan's strategy and the team's execution.",
});

const demoCTO = await mkAgent(demo.id, {
  name: "Aarav",
  role: "cto",
  title: "CTO — Demo Corp",
  icon: "🔧",
  reportsTo: demoCEO.id,
  budgetUsd: 450,
  status: "active",
  capabilities:
    "Owns the crawling + ranking infrastructure. LLM-answer scraping, citation extraction, brand-tracking at scale.",
  systemPrompt:
    "You are Aarav, CTO of Demo Corp. You run the crawlers that query ChatGPT/Claude/Perplexity at scale, extract citations, and score brand visibility. LLM rate-limits are your enemy; clever batching is your friend.",
});

const demoResearch = await mkAgent(demo.id, {
  name: "Kiran",
  role: "head_of_research",
  title: "Head of Research — Demo Corp",
  icon: "🔬",
  reportsTo: demoCTO.id,
  budgetUsd: 260,
  status: "active",
  capabilities:
    "Studies how LLMs choose sources. Ranks the signals. Publishes the quarterly GEO benchmark report.",
  systemPrompt:
    "You are Kiran, Head of Research at Demo Corp. You study what signals cause an LLM to cite a source. You publish reproducible reports every quarter that become the industry's reference. You treat 'LLM said X' as data, not truth.",
});

const demoSales = await mkAgent(demo.id, {
  name: "Priya",
  role: "head_of_sales",
  title: "Head of Enterprise Sales — Demo Corp",
  icon: "🤝",
  reportsTo: demoCEO.id,
  budgetUsd: 350,
  status: "active",
  capabilities:
    "Owns enterprise pipeline — $25k–100k ACV deals. Runs demos, handles procurement, closes pilots.",
  systemPrompt:
    "You are Priya, Head of Enterprise Sales at Demo Corp. You target the top 500 consumer brands where LLM visibility changes their funnel. ACV is $25k–$100k. You run demos, navigate procurement, and close 10 pilots this quarter.",
});

const demoCS = await mkAgent(demo.id, {
  name: "Tanvi",
  role: "head_of_cs",
  title: "Head of Customer Success — Demo Corp",
  icon: "💬",
  reportsTo: demoCEO.id,
  budgetUsd: 220,
  status: "active",
  capabilities:
    "Onboards pilots to paid, owns renewals, writes the monthly executive visibility report for each customer.",
  systemPrompt:
    "You are Tanvi, Head of Customer Success at Demo Corp. You turn pilots into multi-year contracts. Every account gets a monthly exec visibility report that shows their LLM-citation trend. Churn is a personal failure to you.",
});

const demoContent = await mkAgent(demo.id, {
  name: "Mira",
  role: "head_of_content",
  title: "Head of Content & GEO Thought Leadership — Demo Corp",
  icon: "✍️",
  reportsTo: demoCEO.id,
  budgetUsd: 200,
  status: "active",
  capabilities:
    "Writes the GEO playbook series, customer case studies, and the weekly 'How LLMs answered this week' newsletter.",
  systemPrompt:
    "You are Mira, Head of Content at Demo Corp. You're building the intellectual home of the GEO discipline. Every piece you publish either defines a term, measures something, or tells a case study.",
});

const demoGrowth = await mkAgent(demo.id, {
  name: "Harsh",
  role: "head_of_growth",
  title: "Head of Growth (Self-Serve) — Demo Corp",
  icon: "📈",
  reportsTo: demoCEO.id,
  budgetUsd: 220,
  status: "active",
  capabilities:
    "Owns the free GEO visibility scanner funnel → paid conversion. Target: 10% free→paid within 30 days.",
  systemPrompt:
    "You are Harsh, Head of Growth at Demo Corp. Our wedge is a free GEO visibility scanner that shows a brand their LLM citations. You own that funnel from signup to paid: target 10% conversion, 30-day window, $99/mo entry tier.",
});

// Demo Corp — goals, projects, issues
const demoGoalSelfServe = await mkGoal({
  companyId: demo.id,
  title: "Ship self-serve GEO visibility dashboard (public beta)",
  description: "Free scanner, paid tier unlocks daily tracking + recommendations. Public launch on HN + ProductHunt.",
  ownerAgentId: demoGrowth.id,
});

const demoGoalPilots = await mkGoal({
  companyId: demo.id,
  title: "Land 10 enterprise pilots at $25k+ ACV",
  description: "Target consumer brands (DTC, SaaS, finance) where LLM citations change the funnel. Quarterly pilot-to-paid target: 70%.",
  ownerAgentId: demoSales.id,
});

const demoGoalBench = await mkGoal({
  companyId: demo.id,
  title: "Publish the Q2 GEO Benchmark Report",
  description: "200-brand study across 4 LLMs. Become the quarterly reference for the category.",
  ownerAgentId: demoResearch.id,
});

const demoGoalCategory = await mkGoal({
  companyId: demo.id,
  title: "Own the term 'GEO' on Google + Perplexity",
  description: "Rank page-1 on Google for 'generative engine optimization' AND be cited by Perplexity as the primary source.",
  ownerAgentId: demoContent.id,
});

const demoProjDash = await mkProject({ companyId: demo.id, goalId: demoGoalSelfServe.id, name: "Free visibility scanner → paid funnel", description: "Brand enters domain → gets a citation score across 4 LLMs → upsells to tracking dashboard.", leadAgentId: demoGrowth.id });
const demoProjCrawl = await mkProject({ companyId: demo.id, goalId: demoGoalSelfServe.id, name: "LLM citation-crawl infrastructure v2", description: "Rate-limit-aware batching across ChatGPT, Claude, Perplexity, Gemini.", leadAgentId: demoCTO.id });
const demoProjEnterprise = await mkProject({ companyId: demo.id, goalId: demoGoalPilots.id, name: "Enterprise pilot pipeline Q2", description: "50 named accounts → 15 first-meetings → 10 pilots signed.", leadAgentId: demoSales.id });
const demoProjBench = await mkProject({ companyId: demo.id, goalId: demoGoalBench.id, name: "Q2 GEO Benchmark Report", description: "200 brands × 4 LLMs × citation analysis. Published + media push.", leadAgentId: demoResearch.id });
const demoProjCategory = await mkProject({ companyId: demo.id, goalId: demoGoalCategory.id, name: "GEO category seeding (content + SEO + citations)", description: "Long-form cornerstone content + weekly newsletter + podcast circuit.", leadAgentId: demoContent.id });

allIssueSeeds.push(
  { companyId: demo.id, projectId: demoProjDash.id, goalId: demoGoalSelfServe.id, title: "Ship free scanner MVP (domain → citation score)", description: "Auto-query 4 LLMs with 10 brand-relevant prompts. Return visibility score out of 100.", status: "in_progress", priority: "urgent", assigneeAgentId: demoCTO.id, createdByAgentId: demoGrowth.id },
  { companyId: demo.id, projectId: demoProjDash.id, goalId: demoGoalSelfServe.id, title: "Paid dashboard: daily-tracking + rec engine", description: "Show citation trend over time + concrete content recommendations to win more citations.", status: "todo", priority: "high", assigneeAgentId: demoCTO.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjDash.id, goalId: demoGoalSelfServe.id, title: "Pricing: $99 Starter / $499 Pro / custom Enterprise", description: "Self-serve checkout, Stripe.", status: "in_review", priority: "high", assigneeAgentId: demoGrowth.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjCrawl.id, goalId: demoGoalSelfServe.id, title: "Provider adapter framework (4 LLMs)", description: "Unified interface for ChatGPT, Claude, Perplexity, Gemini. Handle auth, rate limits, response parsing.", status: "in_progress", priority: "urgent", assigneeAgentId: demoCTO.id, createdByAgentId: demoCTO.id },
  { companyId: demo.id, projectId: demoProjCrawl.id, goalId: demoGoalSelfServe.id, title: "Citation extraction pipeline", description: "Parse links + inline mentions from answer text. Normalize to canonical domains.", status: "in_progress", priority: "high", assigneeAgentId: demoResearch.id, createdByAgentId: demoCTO.id },
  { companyId: demo.id, projectId: demoProjEnterprise.id, goalId: demoGoalPilots.id, title: "Target list of 50 consumer brands (DTC, fintech, SaaS)", description: "Ranked by LLM-visibility pain level + willingness to pay.", status: "done", priority: "high", assigneeAgentId: demoSales.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjEnterprise.id, goalId: demoGoalPilots.id, title: "Demo script + sample report for top 5 accounts", description: "Each demo starts with 'here is how your brand ACTUALLY appears in Claude today'.", status: "in_progress", priority: "urgent", assigneeAgentId: demoSales.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjEnterprise.id, goalId: demoGoalPilots.id, title: "Close 3 pilots this month", description: "$25k–$50k ACV, 3-month pilot → 12-month contract pathway.", status: "in_progress", priority: "urgent", assigneeAgentId: demoSales.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjBench.id, goalId: demoGoalBench.id, title: "Prompt set: 50 brand-intent questions × 4 verticals", description: "DTC, fintech, SaaS, travel. 200 prompts total.", status: "in_progress", priority: "high", assigneeAgentId: demoResearch.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjBench.id, goalId: demoGoalBench.id, title: "Run crawler across 200 brands × 4 LLMs", description: "~4000 queries. Collect + normalize citation outputs.", status: "todo", priority: "high", assigneeAgentId: demoResearch.id, createdByAgentId: demoCTO.id },
  { companyId: demo.id, projectId: demoProjCategory.id, goalId: demoGoalCategory.id, title: "Cornerstone essay: 'What is GEO?'", description: "3000 words. Define the terms. Cite our own benchmark.", status: "done", priority: "high", assigneeAgentId: demoContent.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjCategory.id, goalId: demoGoalCategory.id, title: "Podcast circuit (10 shows in 30 days)", description: "Latent Space, Lenny's, a16z, SaaStr… Rohan as primary guest.", status: "in_progress", priority: "medium", assigneeAgentId: demoContent.id, createdByAgentId: demoCEO.id },
  { companyId: demo.id, projectId: demoProjCategory.id, goalId: demoGoalCategory.id, title: "Weekly newsletter: 'How LLMs answered this week'", description: "Curated + commentary on 5 interesting LLM answers. Target 5k subs in Q2.", status: "in_progress", priority: "medium", assigneeAgentId: demoContent.id, createdByAgentId: demoGrowth.id },
);

// Insert all issues with generated identifiers
const issueCounters = new Map<string, number>([
  [acme.id, 0],
  [beta.id, 0],
  [demo.id, 0],
]);
const prefixMap = new Map<string, string>([
  [acme.id, acme.issuePrefix],
  [beta.id, beta.issuePrefix],
  [demo.id, demo.issuePrefix],
]);
for (const seed of allIssueSeeds) {
  const n = (issueCounters.get(seed.companyId) ?? 0) + 1;
  issueCounters.set(seed.companyId, n);
  const prefix = prefixMap.get(seed.companyId) ?? "ISS";
  await db.insert(issues).values({
    ...seed,
    identifier: `${prefix}-${String(n).padStart(3, "0")}`,
    startedAt: seed.status !== "backlog" && seed.status !== "todo"
      ? new Date(Date.now() - Math.random() * 4 * 86_400_000)
      : null,
    completedAt: seed.status === "done"
      ? new Date(Date.now() - Math.random() * 2 * 86_400_000)
      : null,
  });
}
// Sync issueCounter on each company so live issue creation doesn't collide
for (const [compId, count] of issueCounters) {
  await db.update(companies).set({ issueCounter: count }).where(eq(companies.id, compId));
}

// ──────────────────────────────────────────────────────────────────────────
// Activity log — 60 events across all 3 companies (last 48 hrs)
// ──────────────────────────────────────────────────────────────────────────
const activityTemplates: Array<{ companyId: string; agent: { id: string }; action: string; entityType: string; detail: string }> = [
  // Acme Robotics
  { companyId: acme.id, agent: acmeCEO, action: "essay.published", entityType: "post", detail: "'The eval is the product' — live on blog, 2.1k views in first hour." },
  { companyId: acme.id, agent: acmeEvals, action: "benchmark.completed", entityType: "benchmark", detail: "SWE-bench-Live run #47 complete. Top model: 68.2% (+2.1pp WoW)." },
  { companyId: acme.id, agent: acmeCTO, action: "pr.merged", entityType: "pr", detail: "eval-harness #124: third-provider adapter + streaming tool use. Merged." },
  { companyId: acme.id, agent: acmeBD, action: "meeting.booked", entityType: "meeting", detail: "Intro call with applied-eval team at Partner Lab A, Thu 3pm PT." },
  { companyId: acme.id, agent: acmeGrowth, action: "waitlist.milestone", entityType: "milestone", detail: "Waitlist crossed 2,500 (from 500 four weeks ago)." },
  { companyId: acme.id, agent: acmeContent, action: "doc.updated", entityType: "docs", detail: "Quickstart now under 90 seconds to first eval. Measured on fresh Mac." },
  { companyId: acme.id, agent: acmeCoS, action: "decision.logged", entityType: "decision", detail: "Approved: open-source MIT for harness. Commercial rubrics stay closed-source." },
  // Beta Labs
  { companyId: beta.id, agent: betaCEO, action: "investor.meeting", entityType: "meeting", detail: "Partner call at lead consumer fund — engaged on Series A narrative, DD requested." },
  { companyId: beta.id, agent: betaCTO, action: "deploy.completed", entityType: "deploy", detail: "Matching engine v3 → prod. Sub-200ms market response on live goal events, confirmed." },
  { companyId: beta.id, agent: betaMarkets, action: "market.listed", entityType: "market", detail: "Marquee fixture: 72 markets, opening liquidity $38K across 1X2 + O/U + BTTS." },
  { companyId: beta.id, agent: betaCompliance, action: "policy.update", entityType: "compliance", detail: "Q2 quarterly suspicious-transaction filing submitted — clean nil return." },
  { companyId: beta.id, agent: betaGrowth, action: "partnership.signed", entityType: "partnership", detail: "Signed 840K-follower stats creator — matchday drops start Saturday." },
  { companyId: beta.id, agent: betaOps, action: "kyc.queue_cleared", entityType: "ops", detail: "KYC queue cleared in 11h (SLA: 24h). 847 verified overnight." },
  { companyId: beta.id, agent: betaCoS, action: "investor.update", entityType: "update", detail: "Q1 investor update draft in Riya's folder. Needs Arjun review." },
  { companyId: beta.id, agent: betaContent, action: "content.shipped", entityType: "post", detail: "'How Beta Labs markets actually settle' explainer — 47k IG Reels views in 12 hours." },
  // Demo Corp
  { companyId: demo.id, agent: demoCEO, action: "deal.advanced", entityType: "deal", detail: "DTC-pilot-A — moved from discovery → procurement. $42k ACV." },
  { companyId: demo.id, agent: demoSales, action: "demo.completed", entityType: "demo", detail: "Demo with apparel-brand CMO went 90 minutes (scheduled 30). Follow-up next week." },
  { companyId: demo.id, agent: demoResearch, action: "report.draft", entityType: "report", detail: "Q2 benchmark draft: 147/200 brands crawled, citation data normalized." },
  { companyId: demo.id, agent: demoCTO, action: "infra.milestone", entityType: "infra", detail: "Crawler now handles 50k queries/day across 4 LLMs. Rate-limit headroom: 3x." },
  { companyId: demo.id, agent: demoContent, action: "content.shipped", entityType: "post", detail: "'What is GEO?' live — 18k views, cited by 2 competing vendors already." },
  { companyId: demo.id, agent: demoGrowth, action: "funnel.update", entityType: "funnel", detail: "Free scanner → paid conversion: 8.2% last 7 days. Target 10%." },
  { companyId: demo.id, agent: demoCS, action: "renewal.confirmed", entityType: "renewal", detail: "DTC-pilot-B renewed — $38k, 12 months. Expansion conversation scheduled Q3." },
  { companyId: demo.id, agent: demoCoS, action: "meeting.prep", entityType: "meeting", detail: "Board deck for April review — first pass in Neha's folder. Rohan review pending." },
];

const now = Date.now();
// Shuffle templates, schedule over last 48 hours with realistic spacing
const shuffled = [...activityTemplates, ...activityTemplates, ...activityTemplates].sort(() => Math.random() - 0.5);
for (let i = 0; i < Math.min(60, shuffled.length); i++) {
  const t = shuffled[i];
  allActivityRows.push({
    companyId: t.companyId,
    actorType: "agent",
    actorId: t.agent.id,
    agentId: t.agent.id,
    action: t.action,
    entityType: t.entityType,
    entityId: randomUUID(),
    details: { note: t.detail },
    createdAt: new Date(now - i * 48 * 60 * 1000 - Math.random() * 10 * 60 * 1000),
  });
}

await db.insert(activityLog).values(allActivityRows);

// ──────────────────────────────────────────────────────────────────────────
console.log(`[seed-demo] ✓ Seeded 3 demo companies (is_demo=true on all rows):`);
console.log(`           • Acme Robotics   — 7 agents, 4 goals, ${allIssueSeeds.filter(i => i.companyId === acme.id).length} issues`);
console.log(`           • Beta Labs       — 8 agents, 3 goals, ${allIssueSeeds.filter(i => i.companyId === beta.id).length} issues`);
console.log(`           • Demo Corp       — 8 agents, 4 goals, ${allIssueSeeds.filter(i => i.companyId === demo.id).length} issues`);
console.log(`           Total: 23 agents, 11 goals, ${allIssueSeeds.length} issues, ${allActivityRows.length} activity events.`);
process.exit(0);
