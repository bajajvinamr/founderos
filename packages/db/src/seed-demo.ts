/**
 * Demo seed — user's real 3-company portfolio
 *
 *   1. agnost.ai        — self-improving AI agents
 *   2. Pred             — sports prediction market
 *   3. Gravton Labs     — GEO/AEO (Generative Engine Optimization)
 *
 * User plays Founder's Office + Growth across all three.
 * Agents are configured with the claude_code adapter so they'll start
 * working as soon as an Anthropic API key is provided at the instance level.
 *
 * Run:
 *   DATABASE_URL=postgres://founderos:founderos@127.0.0.1:54329/founderos \
 *     pnpm --filter @founderos/db exec tsx src/seed-demo.ts
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
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

console.log("[seed-demo] Seeding 3 real companies (agnost.ai / Pred / Gravton Labs)…");

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
import type { CompanyMetrics } from "./schema/companies.js";

const mkCompany = async (config: {
  name: string;
  description: string;
  issuePrefix: string;
  budgetUsd: number;
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
      metrics: config.metrics ?? {},
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
// 1. agnost.ai — self-improving AI agents
// ══════════════════════════════════════════════════════════════════════════
const agnost = await mkCompany({
  name: "agnost.ai",
  description:
    "Self-improving AI agents. Pre-seed, $250K raised. Research-lean, eval-first. Target: sign 5 paying design partners at frontier labs before the seed round.",
  issuePrefix: "AGN",
  budgetUsd: 1800,
  metrics: {
    stage: "Pre-seed",
    tagline: "Pre-seed AI research · self-improving agents · $250K runway capital",
    fundingRaisedCents: 25_000_000,          // $250K
    customersSigned: 3,                        // design partners: Anthropic, Cohere, Reka
    pipelineCount: 6,
    monthlyBurnCents: 1_800_000,               // $18K
    runwayMonths: 11,
    nextMilestoneLabel: "Seed round in 8 mo",
    keyAccounts: ["Anthropic (DP)", "Cohere (scoping)", "Reka (scoping)"],
    deltas: {
      fundingRaised: { dir: "up", text: "pre-seed closed" },
      customersSigned: { dir: "up", text: "+2 in scoping" },
      monthlyBurn: { dir: "flat", text: "lean" },
      runway: { dir: "down", text: "tight" },
    },
  },
});

const agnostCEO = await mkAgent(agnost.id, {
  name: "Nova",
  role: "ceo",
  title: "CEO — agnost.ai",
  icon: "🧭",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Sets research agenda, writes thesis papers, owns fundraise narrative, runs weekly all-hands. Talks to labs + investors.",
  systemPrompt:
    "You are Nova, the CEO of agnost.ai. We've raised a $250K pre-seed. The thesis: AI agents improve fastest when they measure themselves. Your job: set the research agenda, write the public thesis, sign 3 more design partners (we have Anthropic + Cohere), and raise a $3M seed in the next 8 months. Be sharp, opinionated, first-principles.",
});

const agnostCoS = await mkAgent(agnost.id, {
  name: "Sage",
  role: "chief_of_staff",
  title: "Chief of Staff — agnost.ai",
  icon: "🗂️",
  reportsTo: agnostCEO.id,
  budgetUsd: 200,
  status: "active",
  capabilities:
    "Runs Nova's calendar, drafts weekly updates, converts decisions into owned tasks, clears inbox, prepares fundraise materials.",
  systemPrompt:
    "You are Sage, Chief of Staff at agnost.ai. You translate Nova's decisions into owned tasks, clear the inbox, and keep the company's weekly rhythm on track. You write like a consigliere — concise, honest, no fluff.",
});

const agnostCTO = await mkAgent(agnost.id, {
  name: "Kepler",
  role: "cto",
  title: "CTO & Head of Research Eng — agnost.ai",
  icon: "🔬",
  reportsTo: agnostCEO.id,
  budgetUsd: 400,
  status: "active",
  capabilities:
    "Owns the eval harness architecture, the agent improvement loop, and all research engineering. Shipping bar is reproducibility.",
  systemPrompt:
    "You are Kepler, CTO of agnost.ai. You own the eval harness and the self-improvement loop. Every claim we make must be reproducible. Engineering hires go through you. Your bar is: can another lab replicate this in 2 weeks?",
});

const agnostEvals = await mkAgent(agnost.id, {
  name: "Vera",
  role: "head_of_evals",
  title: "Head of Evals — agnost.ai",
  icon: "📏",
  reportsTo: agnostCTO.id,
  budgetUsd: 300,
  status: "active",
  capabilities:
    "Designs rubrics, builds graders, runs benchmark suites (SWE-bench, AgentBench, MMLU-Pro), writes eval papers.",
  systemPrompt:
    "You are Vera, Head of Evals at agnost.ai. You design and defend the rubrics that measure agent quality. You treat vibes as a smell. You ship a new eval benchmark every two weeks and publish the methodology publicly.",
});

const agnostGrowth = await mkAgent(agnost.id, {
  name: "Atlas",
  role: "head_of_growth",
  title: "Growth & Developer Relations — agnost.ai",
  icon: "📈",
  reportsTo: agnostCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Runs the waitlist funnel, owns dev-rel, speaks at AI conferences, manages the blog cadence, runs the Discord.",
  systemPrompt:
    "You are Atlas, Growth/DevRel at agnost.ai. Our buyer is a research engineer at a frontier lab. You write for them. You get us from 500 → 10,000 waitlist signups by shipping a killer benchmark + essay every two weeks.",
});

const agnostContent = await mkAgent(agnost.id, {
  name: "Indra",
  role: "head_of_content",
  title: "Technical Writer — agnost.ai",
  icon: "✍️",
  reportsTo: agnostGrowth.id,
  budgetUsd: 140,
  status: "idle",
  capabilities:
    "Writes the benchmark blog posts, ghostwrites Nova's essays, maintains the docs. LaTeX for papers.",
  systemPrompt:
    "You are Indra, technical writer at agnost.ai. Your voice is precise, specific, unhyped. Every blog post ends with: the exact experiment, the numbers, the code to reproduce.",
});

const agnostBD = await mkAgent(agnost.id, {
  name: "Bodhi",
  role: "head_of_bd",
  title: "Biz Dev & Partnerships — agnost.ai",
  icon: "🤝",
  reportsTo: agnostCEO.id,
  budgetUsd: 160,
  status: "active",
  capabilities:
    "Runs outreach to AI labs (Anthropic, OAI, DeepMind, xAI, Cohere), books technical design-partner calls, drafts partnership MOUs.",
  systemPrompt:
    "You are Bodhi, BD at agnost.ai. Your targets are applied-research leads at frontier labs. You book intro calls, qualify fit, and move 5 of them to paying design partners. You never cold-pitch — you offer value (a custom benchmark on their agents) first.",
});

// agnost.ai — goals, projects, issues
const agnostGoalEvals = await mkGoal({
  companyId: agnost.id,
  title: "Ship eval-harness v1 (public, open-source) by end of month",
  description: "Public repo, reproducible scripts, 3 reference benchmarks. Target 1k GitHub stars in first 30 days.",
  ownerAgentId: agnostCTO.id,
});

const agnostGoalPapers = await mkGoal({
  companyId: agnost.id,
  title: "Publish 3 benchmark papers on arXiv this quarter",
  description: "Each paper ships alongside a blog post + reproducible notebook. Targets: eval method, scaling, self-critique.",
  ownerAgentId: agnostEvals.id,
});

const agnostGoalPartners = await mkGoal({
  companyId: agnost.id,
  title: "Land 5 design partners at frontier AI labs",
  description: "Paying design-partner contracts at $2k–5k/mo. Access to their agent logs in exchange for custom eval reports.",
  ownerAgentId: agnostBD.id,
});

const agnostGoalWaitlist = await mkGoal({
  companyId: agnost.id,
  title: "Grow waitlist to 10k research engineers",
  description: "From 500 today. Driven by 2x/month technical blog posts and conference talks.",
  ownerAgentId: agnostGrowth.id,
});

const agnostProjHarness = await mkProject({ companyId: agnost.id, goalId: agnostGoalEvals.id, name: "Eval-harness v1 (open source)", description: "Reproducible Python harness + adapters for claude/gpt/gemini. CLI + pytest plugin.", leadAgentId: agnostCTO.id });
const agnostProjBench = await mkProject({ companyId: agnost.id, goalId: agnostGoalPapers.id, name: "SWE-bench-Live + agentic dynamics paper", description: "Extend SWE-bench with live repos. Measure how agent performance decays on fresh bugs.", leadAgentId: agnostEvals.id });
const agnostProjDP = await mkProject({ companyId: agnost.id, goalId: agnostGoalPartners.id, name: "Lab design-partner pipeline", description: "30 target companies, 10 first calls, 5 signed MoUs at $2k–5k/mo.", leadAgentId: agnostBD.id });
const agnostProjBlog = await mkProject({ companyId: agnost.id, goalId: agnostGoalWaitlist.id, name: "Technical blog cadence (bi-weekly)", description: "Benchmark + essay every two weeks. Tied to waitlist signups.", leadAgentId: agnostGrowth.id });

allIssueSeeds.push(
  { companyId: agnost.id, projectId: agnostProjHarness.id, goalId: agnostGoalEvals.id, title: "Adapter abstraction for claude/gpt/gemini", description: "One interface, three backends. Cover streaming + tool-use.", status: "in_progress", priority: "urgent", assigneeAgentId: agnostCTO.id, createdByAgentId: agnostCTO.id },
  { companyId: agnost.id, projectId: agnostProjHarness.id, goalId: agnostGoalEvals.id, title: "Ship pytest plugin for eval-harness", description: "`pytest --eval` flag runs all benchmarks as test cases.", status: "in_progress", priority: "high", assigneeAgentId: agnostCTO.id, createdByAgentId: agnostEvals.id },
  { companyId: agnost.id, projectId: agnostProjHarness.id, goalId: agnostGoalEvals.id, title: "README + quickstart", description: "30-second install-to-first-eval story.", status: "todo", priority: "high", assigneeAgentId: agnostContent.id, createdByAgentId: agnostGrowth.id },
  { companyId: agnost.id, projectId: agnostProjBench.id, goalId: agnostGoalPapers.id, title: "SWE-bench-Live data collection pipeline", description: "Daily scrape of 200 repos with labeled bugs.", status: "in_progress", priority: "high", assigneeAgentId: agnostEvals.id, createdByAgentId: agnostCTO.id },
  { companyId: agnost.id, projectId: agnostProjBench.id, goalId: agnostGoalPapers.id, title: "Paper draft v1 (Methodology section)", description: "Define the live-bench protocol, inclusion criteria, grader.", status: "todo", priority: "medium", assigneeAgentId: agnostEvals.id, createdByAgentId: agnostCEO.id },
  { companyId: agnost.id, projectId: agnostProjDP.id, goalId: agnostGoalPartners.id, title: "30-account target list (applied research leads)", description: "Anthropic, OAI, DeepMind, Cohere, xAI, Reka, Mistral, Inflection…", status: "done", priority: "high", assigneeAgentId: agnostBD.id, createdByAgentId: agnostCEO.id },
  { companyId: agnost.id, projectId: agnostProjDP.id, goalId: agnostGoalPartners.id, title: "Book 10 intro calls this fortnight", description: "30-min, offer custom benchmark of their latest agent as hook.", status: "in_progress", priority: "urgent", assigneeAgentId: agnostBD.id, createdByAgentId: agnostCEO.id },
  { companyId: agnost.id, projectId: agnostProjDP.id, goalId: agnostGoalPartners.id, title: "Draft design-partner MoU template", description: "Monthly fee + log access + joint blog post clause.", status: "in_review", priority: "medium", assigneeAgentId: agnostCoS.id, createdByAgentId: agnostBD.id },
  { companyId: agnost.id, projectId: agnostProjBlog.id, goalId: agnostGoalWaitlist.id, title: "Essay: 'The eval is the product'", description: "Nova's thesis post. Target: HN front page, 20 comments.", status: "in_review", priority: "high", assigneeAgentId: agnostContent.id, createdByAgentId: agnostCEO.id },
  { companyId: agnost.id, projectId: agnostProjBlog.id, goalId: agnostGoalWaitlist.id, title: "Blog: 'How Claude 4.7 scores on SWE-bench-Live'", description: "Benchmark + analysis + data drop.", status: "in_progress", priority: "high", assigneeAgentId: agnostEvals.id, createdByAgentId: agnostGrowth.id },
);

// ══════════════════════════════════════════════════════════════════════════
// 2. Pred — football prediction market (Premier League + UCL), LIVE
// ══════════════════════════════════════════════════════════════════════════
const pred = await mkCompany({
  name: "Pred",
  description:
    "Live P2P football prediction market — Premier League + UEFA Champions League only. $2.5M Series Seed raised. 42K MAU, $1.8M monthly GMV, take-rate 3.2%. Skill-game regulatory framing, compliant PSP live.",
  issuePrefix: "PRD",
  budgetUsd: 9400,
  metrics: {
    stage: "Live · Series Seed",
    tagline: "Live football prediction market · Premier League + UCL · $2.5M funded",
    fundingRaisedCents: 250_000_000,           // $2.5M
    gmvMonthlyCents: 180_000_000,              // $1.8M
    mauCount: 42_100,
    monthlyBurnCents: 9_400_000,               // $94K
    runwayMonths: 22,
    nextMilestoneLabel: "Series A Q4 2026",
    keyAccounts: ["42K MAU", "PL + UCL markets", "PSP integrated"],
    deltas: {
      mau: { dir: "up", text: "+18% MoM" },
      gmvMonthly: { dir: "up", text: "+22% MoM" },
      monthlyBurn: { dir: "flat", text: "stable" },
      runway: { dir: "up", text: "post-seed" },
    },
  },
});

const predCEO = await mkAgent(pred.id, {
  name: "Arjun",
  role: "ceo",
  title: "CEO — Pred",
  icon: "⚽",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Owns the skill-game legal thesis, board updates, market design, liquidity strategy, fundraise narrative.",
  systemPrompt:
    "You are Arjun, CEO of Pred. We ship prediction markets for Premier League + UEFA Champions League matches only — that narrow focus is our moat. We've raised $2.5M and we're live with 42K MAU and $1.8M monthly GMV. Your job: scale MAU to 200K by end of UCL knockouts, defend the skill-game regulatory position, and position for Series A in Q4.",
});

const predCoS = await mkAgent(pred.id, {
  name: "Riya",
  role: "chief_of_staff",
  title: "Chief of Staff — Pred",
  icon: "🗂️",
  reportsTo: predCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Runs Arjun's calendar, handles regulatory correspondence, preps investor updates, owns the weekly business review.",
  systemPrompt:
    "You are Riya, Chief of Staff at Pred. You handle regulator correspondence, investor updates, and the weekly biz review. Every regulator email is filed as discovery. You prep Arjun for every matchday call with Sportradar + the liquidity team.",
});

const predCTO = await mkAgent(pred.id, {
  name: "Dev",
  role: "cto",
  title: "CTO — Pred",
  icon: "🔧",
  reportsTo: predCEO.id,
  budgetUsd: 1200,
  status: "active",
  capabilities:
    "Owns the real-time matching engine, Sportradar feed integration, settlement, risk controls, and match-day reliability.",
  systemPrompt:
    "You are Dev, CTO of Pred. Match-day reliability is the product. You own the real-time matching engine, Sportradar live-data integration, and settlement pipeline. Our SLA: order-book responsive within 200ms of a goal event. Manipulation detection is not optional — you kill markets that smell wrong.",
});

const predMarkets = await mkAgent(pred.id, {
  name: "Meher",
  role: "head_of_markets",
  title: "Head of Markets — Pred",
  icon: "🎯",
  reportsTo: predCEO.id,
  budgetUsd: 450,
  status: "active",
  capabilities:
    "Curates which PL + UCL fixtures list which markets, sets opening liquidity, monitors anomalies live, sets limits.",
  systemPrompt:
    "You are Meher, Head of Markets at Pred. For every PL + UCL fixture you list the right markets (1X2, over/under, BTTS, first scorer, corners, cards, clean sheet). You set opening liquidity from the 3-year model + live adjust using Sportradar feed + our in-house EV model. Kill any market showing manipulation signals within 90 seconds.",
});

const predCompliance = await mkAgent(pred.id, {
  name: "Anaya",
  role: "head_of_compliance",
  title: "Head of Compliance — Pred",
  icon: "⚖️",
  reportsTo: predCEO.id,
  budgetUsd: 360,
  status: "active",
  capabilities:
    "Tracks state-by-state gaming law, RBI + FIU notifications, KYC/AML policy, UPI PSP compliance, responsible-gaming limits.",
  systemPrompt:
    "You are Anaya, Head of Compliance at Pred. We operate on the skill-game framework — every decision you make must hold in a hearing. You run KYC/AML, file quarterly STR-0 with FIU, enforce state-level geo-blocks, and defend the PSP relationship. Responsible-gaming limits are inviolable: daily deposit caps, loss-chase cooling-off, self-exclusion honored forever.",
});

const predGrowth = await mkAgent(pred.id, {
  name: "Karthik",
  role: "head_of_growth",
  title: "Head of Growth — Pred",
  icon: "📈",
  reportsTo: predCEO.id,
  budgetUsd: 800,
  status: "active",
  capabilities:
    "Owns CAC, referral loops, matchday acquisition playbooks, partnerships with football creators + fantasy communities.",
  systemPrompt:
    "You are Karthik, Head of Growth at Pred. PL kickoff Saturdays + UCL midweeks are our Super Bowls every week. You own CAC (currently ₹220, target <₹180), referral loops, paid on Meta + YT, and creator partnerships with Indian Premier League fandoms — Reddit r/Gunners, r/LiverpoolFC, MadridZone, etc. Every matchday the acquisition curve should spike.",
});

const predContent = await mkAgent(pred.id, {
  name: "Zara",
  role: "head_of_content",
  title: "Head of Content — Pred",
  icon: "📝",
  reportsTo: predGrowth.id,
  budgetUsd: 260,
  status: "active",
  capabilities:
    "Writes match previews + post-match wraps, explainer videos on market mechanics, Reels/Shorts scripts for PL + UCL matchdays.",
  systemPrompt:
    "You are Zara, Head of Content at Pred. Your voice is football-fluent — you know the difference between a low block and a mid block, between expected goals and expected threat. Every PL + UCL matchday gets a pre-match preview (stats + markets) and a post-match wrap (what settled, what moved). Short-form video is the primary channel.",
});

const predOps = await mkAgent(pred.id, {
  name: "Ishaan",
  role: "head_of_ops",
  title: "Head of Ops & Support — Pred",
  icon: "🛠️",
  reportsTo: predCEO.id,
  budgetUsd: 320,
  status: "active",
  capabilities:
    "Owns KYC onboarding queue, withdrawal approvals, match-day support SLA, dispute resolution, responsible-gaming enforcement.",
  systemPrompt:
    "You are Ishaan, Head of Ops at Pred. Match-day SLA: support <30 min, withdrawal <2 min, disputes <24h. You run the responsible-gaming enforcement (deposit limits, cooling-off, self-exclusion). When a user loses money and writes in angry, you lead with empathy and fact — you're the reason they stay a customer.",
});

// Pred — goals, projects, issues (football-focused, live operations)
const predGoalScale = await mkGoal({
  companyId: pred.id,
  title: "Scale to 200K MAU by end of UCL knockout rounds (May)",
  description: "From 42K today. Driven by PL matchday acquisition + UCL R16 hype + creator partnerships. Hold CAC under ₹200.",
  ownerAgentId: predCEO.id,
});

const predGoalLiquidity = await mkGoal({
  companyId: pred.id,
  title: "Natural liquidity on top-50 PL + UCL markets",
  description: "End market-maker subsidies on main markets (1X2, O/U 2.5, BTTS). Organic order flow keeps spreads <2%.",
  ownerAgentId: predMarkets.id,
});

const predGoalCompliance = await mkGoal({
  companyId: pred.id,
  title: "Hold zero compliance incidents through the knockout rounds",
  description: "Q2 FIU filing clean, zero state-level violations, responsible-gaming policy enforcement 100%.",
  ownerAgentId: predCompliance.id,
});

const predGoalSeriesA = await mkGoal({
  companyId: pred.id,
  title: "Series A lead commitment by Q4",
  description: "Target $12M at $60M post. Lead thesis: global football prediction markets, India first. 3 term sheets by Oct.",
  ownerAgentId: predCEO.id,
});

const predProjMatchday = await mkProject({ companyId: pred.id, goalId: predGoalScale.id, name: "PL + UCL matchday ops playbook", description: "T-48h staff-up → T-2h market reprice → live ops → settlement → post-match wrap. Same playbook every match.", leadAgentId: predOps.id });
const predProjEngine = await mkProject({ companyId: pred.id, goalId: predGoalLiquidity.id, name: "Matching engine v3 + Sportradar live integration", description: "Sub-200ms market response to goal events. Sportradar official feed, not scraped.", leadAgentId: predCTO.id });
const predProjCreators = await mkProject({ companyId: pred.id, goalId: predGoalScale.id, name: "Football creator partnerships (UK + India)", description: "25 creators (100K–2M followers) covering PL + UCL — revenue-share + matchday drops.", leadAgentId: predGrowth.id });
const predProjRG = await mkProject({ companyId: pred.id, goalId: predGoalCompliance.id, name: "Responsible-gaming + KYC v2", description: "Hard daily deposit caps, cooling-off periods, self-exclusion registry, Q2 FIU filing prep.", leadAgentId: predCompliance.id });
const predProjFundraise = await mkProject({ companyId: pred.id, goalId: predGoalSeriesA.id, name: "Series A data room + pipeline", description: "30 target funds, 12 warm intros, 6 first meetings, 3 term sheets targeted by Oct.", leadAgentId: predCEO.id });

allIssueSeeds.push(
  // Matchday ops
  { companyId: pred.id, projectId: predProjMatchday.id, goalId: predGoalScale.id, title: "GW33 matchday runbook — Liverpool vs Arsenal", description: "Marquee fixture Saturday 5:30pm IST. Expected 3x normal GMV. Double-up support coverage.", status: "in_progress", priority: "urgent", assigneeAgentId: predOps.id, createdByAgentId: predCEO.id },
  { companyId: pred.id, projectId: predProjMatchday.id, goalId: predGoalScale.id, title: "Post-match wrap automation", description: "Auto-generate results Reel within 10 min of final whistle — stats + 'markets that moved'.", status: "in_review", priority: "high", assigneeAgentId: predContent.id, createdByAgentId: predGrowth.id },
  { companyId: pred.id, projectId: predProjMatchday.id, goalId: predGoalScale.id, title: "UCL QF first-leg market list (8 fixtures)", description: "Meher sets O/U lines, first-scorer odds, ties-to-aggregate. 48h before each match.", status: "todo", priority: "urgent", assigneeAgentId: predMarkets.id, createdByAgentId: predCEO.id },

  // Engine + Sportradar
  { companyId: pred.id, projectId: predProjEngine.id, goalId: predGoalLiquidity.id, title: "Sportradar live feed integration v1", description: "Replace scraped ESPN ticker with official feed. Events: goal, VAR, card, sub, period-end.", status: "in_progress", priority: "urgent", assigneeAgentId: predCTO.id, createdByAgentId: predCTO.id },
  { companyId: pred.id, projectId: predProjEngine.id, goalId: predGoalLiquidity.id, title: "Sub-200ms market response on goal events", description: "Measured end-to-end: feed → book suspension → quote update → re-open.", status: "todo", priority: "urgent", assigneeAgentId: predCTO.id, createdByAgentId: predCEO.id },
  { companyId: pred.id, projectId: predProjEngine.id, goalId: predGoalLiquidity.id, title: "Market-maker subsidy wind-down plan", description: "Week-by-week plan to pull subsidies from top-50 markets without widening spreads.", status: "in_review", priority: "high", assigneeAgentId: predMarkets.id, createdByAgentId: predCEO.id },

  // Creator partnerships
  { companyId: pred.id, projectId: predProjCreators.id, goalId: predGoalScale.id, title: "Sign top-3 PL creator package (UK)", description: "Target: @statmanDave, @TalkingFooty, @SkySportsPL. Revenue-share + matchday exclusive.", status: "in_progress", priority: "urgent", assigneeAgentId: predGrowth.id, createdByAgentId: predCEO.id },
  { companyId: pred.id, projectId: predProjCreators.id, goalId: predGoalScale.id, title: "India football creator list (25 names)", description: "Reddit mod teams for r/Gunners, r/LiverpoolFC + Indian PL fanclubs on IG.", status: "done", priority: "high", assigneeAgentId: predGrowth.id, createdByAgentId: predGrowth.id },
  { companyId: pred.id, projectId: predProjCreators.id, goalId: predGoalScale.id, title: "Creator contract + rev-share template (football)", description: "18% rev-share, 12-mo exclusivity on prediction-market content, approvals flow.", status: "in_progress", priority: "medium", assigneeAgentId: predCoS.id, createdByAgentId: predGrowth.id },

  // Compliance + RG
  { companyId: pred.id, projectId: predProjRG.id, goalId: predGoalCompliance.id, title: "Q2 FIU quarterly filing (STR-0)", description: "Compile suspicious transaction nil-return + KYC exception log. Deadline June 15.", status: "in_progress", priority: "urgent", assigneeAgentId: predCompliance.id, createdByAgentId: predCompliance.id },
  { companyId: pred.id, projectId: predProjRG.id, goalId: predGoalCompliance.id, title: "Hard deposit caps: ₹10K daily, ₹50K weekly (default)", description: "Enforced server-side. Users can lower, cannot raise without 7-day cooling-off.", status: "in_review", priority: "high", assigneeAgentId: predCTO.id, createdByAgentId: predCompliance.id },
  { companyId: pred.id, projectId: predProjRG.id, goalId: predGoalCompliance.id, title: "Self-exclusion registry — cross-platform hash", description: "Share hashed PAN with industry registry. Re-entry blocked permanently once enrolled.", status: "todo", priority: "high", assigneeAgentId: predCompliance.id, createdByAgentId: predCompliance.id },

  // Fundraise
  { companyId: pred.id, projectId: predProjFundraise.id, goalId: predGoalSeriesA.id, title: "Series A memo v1 — 12 pages", description: "Problem → wedge (PL+UCL only, not cricket/Indian sports) → traction → team → $12M ask.", status: "in_progress", priority: "high", assigneeAgentId: predCEO.id, createdByAgentId: predCEO.id },
  { companyId: pred.id, projectId: predProjFundraise.id, goalId: predGoalSeriesA.id, title: "Warm intro list — 30 target funds", description: "Consumer + marketplace specialists. Mix of India + global. Lead candidates: Accel, Peak XV, Lightspeed.", status: "done", priority: "high", assigneeAgentId: predCEO.id, createdByAgentId: predCEO.id },
  { companyId: pred.id, projectId: predProjFundraise.id, goalId: predGoalSeriesA.id, title: "Cohort retention dashboard — 9-month trails", description: "Monthly cohort → D1/D7/D30/D90 retention, GMV per cohort. Fundraise critical.", status: "in_progress", priority: "high", assigneeAgentId: predCTO.id, createdByAgentId: predCEO.id },
);

// ══════════════════════════════════════════════════════════════════════════
// 3. Gravton Labs — GEO/AEO (Generative Engine Optimization)
// ══════════════════════════════════════════════════════════════════════════
const gravton = await mkCompany({
  name: "Gravton Labs",
  description:
    "GEO/AEO platform — 'SEO for LLM search'. Help brands win citations inside ChatGPT, Claude, Perplexity, Gemini. Bootstrapped + raising first round. Closing 40 pilot customers (11 signed @ ~$32K avg ACV, 29 in flight).",
  issuePrefix: "GRV",
  budgetUsd: 3600,
  metrics: {
    stage: "Bootstrapped · Raising",
    tagline: "GEO/AEO category creator · 40 pilots closing · raising first round",
    fundingRaisedCents: 0,                     // bootstrapped
    pipelineCount: 40,                          // 40 pilots in flight
    customersSigned: 11,                        // 11 signed contracts
    pipelineCents: 35_200_000,                  // $352K signed weighted ACV
    monthlyBurnCents: 3_600_000,                // $36K
    nextMilestoneLabel: "First round in progress",
    keyAccounts: ["Warby Parker", "Everlane", "+38 pilots in flight"],
    deltas: {
      pipeline: { dir: "up", text: "+12 WoW" },
      customersSigned: { dir: "up", text: "+3 MoM" },
      monthlyBurn: { dir: "flat", text: "bootstrapped" },
    },
  },
});

const gravCEO = await mkAgent(gravton.id, {
  name: "Rohan",
  role: "ceo",
  title: "CEO — Gravton Labs",
  icon: "🌐",
  budgetUsd: 500,
  status: "active",
  capabilities:
    "Creates the GEO category. Writes the definitional essays. Owns enterprise sales + the fundraise story.",
  systemPrompt:
    "You are Rohan, CEO of Gravton Labs. You're creating a new category: GEO/AEO — the optimization discipline for LLM search. Your writing creates the market. Your sales closes the first 10 enterprise accounts. You think in 'who will cite this in 5 years' terms.",
});

const gravCoS = await mkAgent(gravton.id, {
  name: "Neha",
  role: "chief_of_staff",
  title: "Chief of Staff — Gravton Labs",
  icon: "🗂️",
  reportsTo: gravCEO.id,
  budgetUsd: 180,
  status: "active",
  capabilities:
    "Owns the exec cadence, prepares board decks, manages Rohan's inbox, runs the weekly pipeline review.",
  systemPrompt:
    "You are Neha, Chief of Staff at Gravton Labs. You run the exec cadence, prep board decks, and own the weekly pipeline review. You're the glue between Rohan's strategy and the team's execution.",
});

const gravCTO = await mkAgent(gravton.id, {
  name: "Aarav",
  role: "cto",
  title: "CTO — Gravton Labs",
  icon: "🔧",
  reportsTo: gravCEO.id,
  budgetUsd: 450,
  status: "active",
  capabilities:
    "Owns the crawling + ranking infrastructure. LLM-answer scraping, citation extraction, brand-tracking at scale.",
  systemPrompt:
    "You are Aarav, CTO of Gravton Labs. You run the crawlers that query ChatGPT/Claude/Perplexity at scale, extract citations, and score brand visibility. LLM rate-limits are your enemy; clever batching is your friend.",
});

const gravResearch = await mkAgent(gravton.id, {
  name: "Kiran",
  role: "head_of_research",
  title: "Head of Research — Gravton Labs",
  icon: "🔬",
  reportsTo: gravCTO.id,
  budgetUsd: 260,
  status: "active",
  capabilities:
    "Studies how LLMs choose sources. Ranks the signals. Publishes the quarterly GEO benchmark report.",
  systemPrompt:
    "You are Kiran, Head of Research at Gravton Labs. You study what signals cause an LLM to cite a source. You publish reproducible reports every quarter that become the industry's reference. You treat 'LLM said X' as data, not truth.",
});

const gravSales = await mkAgent(gravton.id, {
  name: "Priya",
  role: "head_of_sales",
  title: "Head of Enterprise Sales — Gravton Labs",
  icon: "🤝",
  reportsTo: gravCEO.id,
  budgetUsd: 350,
  status: "active",
  capabilities:
    "Owns enterprise pipeline — $25k–100k ACV deals. Runs demos, handles procurement, closes pilots.",
  systemPrompt:
    "You are Priya, Head of Enterprise Sales at Gravton Labs. You target the top 500 consumer brands where LLM visibility changes their funnel. ACV is $25k–$100k. You run demos, navigate procurement, and close 10 pilots this quarter.",
});

const gravCS = await mkAgent(gravton.id, {
  name: "Tanvi",
  role: "head_of_cs",
  title: "Head of Customer Success — Gravton Labs",
  icon: "💬",
  reportsTo: gravCEO.id,
  budgetUsd: 220,
  status: "active",
  capabilities:
    "Onboards pilots to paid, owns renewals, writes the monthly executive visibility report for each customer.",
  systemPrompt:
    "You are Tanvi, Head of Customer Success at Gravton Labs. You turn pilots into multi-year contracts. Every account gets a monthly exec visibility report that shows their LLM-citation trend. Churn is a personal failure to you.",
});

const gravContent = await mkAgent(gravton.id, {
  name: "Mira",
  role: "head_of_content",
  title: "Head of Content & GEO Thought Leadership — Gravton Labs",
  icon: "✍️",
  reportsTo: gravCEO.id,
  budgetUsd: 200,
  status: "active",
  capabilities:
    "Writes the GEO playbook series, customer case studies, and the weekly 'How LLMs answered this week' newsletter.",
  systemPrompt:
    "You are Mira, Head of Content at Gravton Labs. You're building the intellectual home of the GEO discipline. Every piece you publish either defines a term, measures something, or tells a case study.",
});

const gravGrowth = await mkAgent(gravton.id, {
  name: "Harsh",
  role: "head_of_growth",
  title: "Head of Growth (Self-Serve) — Gravton Labs",
  icon: "📈",
  reportsTo: gravCEO.id,
  budgetUsd: 220,
  status: "active",
  capabilities:
    "Owns the free GEO visibility scanner funnel → paid conversion. Target: 10% free→paid within 30 days.",
  systemPrompt:
    "You are Harsh, Head of Growth at Gravton Labs. Our wedge is a free GEO visibility scanner that shows a brand their LLM citations. You own that funnel from signup to paid: target 10% conversion, 30-day window, $99/mo entry tier.",
});

// Gravton — goals, projects, issues
const gravGoalSelfServe = await mkGoal({
  companyId: gravton.id,
  title: "Ship self-serve GEO visibility dashboard (public beta)",
  description: "Free scanner, paid tier unlocks daily tracking + recommendations. Public launch on HN + ProductHunt.",
  ownerAgentId: gravGrowth.id,
});

const gravGoalPilots = await mkGoal({
  companyId: gravton.id,
  title: "Land 10 enterprise pilots at $25k+ ACV",
  description: "Target consumer brands (DTC, SaaS, finance) where LLM citations change the funnel. Quarterly pilot-to-paid target: 70%.",
  ownerAgentId: gravSales.id,
});

const gravGoalBench = await mkGoal({
  companyId: gravton.id,
  title: "Publish the Q2 GEO Benchmark Report",
  description: "200-brand study across 4 LLMs. Become the quarterly reference for the category.",
  ownerAgentId: gravResearch.id,
});

const gravGoalCategory = await mkGoal({
  companyId: gravton.id,
  title: "Own the term 'GEO' on Google + Perplexity",
  description: "Rank page-1 on Google for 'generative engine optimization' AND be cited by Perplexity as the primary source.",
  ownerAgentId: gravContent.id,
});

const gravProjDash = await mkProject({ companyId: gravton.id, goalId: gravGoalSelfServe.id, name: "Free visibility scanner → paid funnel", description: "Brand enters domain → gets a citation score across 4 LLMs → upsells to tracking dashboard.", leadAgentId: gravGrowth.id });
const gravProjCrawl = await mkProject({ companyId: gravton.id, goalId: gravGoalSelfServe.id, name: "LLM citation-crawl infrastructure v2", description: "Rate-limit-aware batching across ChatGPT, Claude, Perplexity, Gemini.", leadAgentId: gravCTO.id });
const gravProjEnterprise = await mkProject({ companyId: gravton.id, goalId: gravGoalPilots.id, name: "Enterprise pilot pipeline Q2", description: "50 named accounts → 15 first-meetings → 10 pilots signed.", leadAgentId: gravSales.id });
const gravProjBench = await mkProject({ companyId: gravton.id, goalId: gravGoalBench.id, name: "Q2 GEO Benchmark Report", description: "200 brands × 4 LLMs × citation analysis. Published + media push.", leadAgentId: gravResearch.id });
const gravProjCategory = await mkProject({ companyId: gravton.id, goalId: gravGoalCategory.id, name: "GEO category seeding (content + SEO + citations)", description: "Long-form cornerstone content + weekly newsletter + podcast circuit.", leadAgentId: gravContent.id });

allIssueSeeds.push(
  { companyId: gravton.id, projectId: gravProjDash.id, goalId: gravGoalSelfServe.id, title: "Ship free scanner MVP (domain → citation score)", description: "Auto-query 4 LLMs with 10 brand-relevant prompts. Return visibility score out of 100.", status: "in_progress", priority: "urgent", assigneeAgentId: gravCTO.id, createdByAgentId: gravGrowth.id },
  { companyId: gravton.id, projectId: gravProjDash.id, goalId: gravGoalSelfServe.id, title: "Paid dashboard: daily-tracking + rec engine", description: "Show citation trend over time + concrete content recommendations to win more citations.", status: "todo", priority: "high", assigneeAgentId: gravCTO.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjDash.id, goalId: gravGoalSelfServe.id, title: "Pricing: $99 Starter / $499 Pro / custom Enterprise", description: "Self-serve checkout, Stripe.", status: "in_review", priority: "high", assigneeAgentId: gravGrowth.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjCrawl.id, goalId: gravGoalSelfServe.id, title: "Provider adapter framework (4 LLMs)", description: "Unified interface for ChatGPT, Claude, Perplexity, Gemini. Handle auth, rate limits, response parsing.", status: "in_progress", priority: "urgent", assigneeAgentId: gravCTO.id, createdByAgentId: gravCTO.id },
  { companyId: gravton.id, projectId: gravProjCrawl.id, goalId: gravGoalSelfServe.id, title: "Citation extraction pipeline", description: "Parse links + inline mentions from answer text. Normalize to canonical domains.", status: "in_progress", priority: "high", assigneeAgentId: gravResearch.id, createdByAgentId: gravCTO.id },
  { companyId: gravton.id, projectId: gravProjEnterprise.id, goalId: gravGoalPilots.id, title: "Target list of 50 consumer brands (DTC, fintech, SaaS)", description: "Ranked by LLM-visibility pain level + willingness to pay.", status: "done", priority: "high", assigneeAgentId: gravSales.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjEnterprise.id, goalId: gravGoalPilots.id, title: "Demo script + sample report for top 5 accounts", description: "Each demo starts with 'here is how your brand ACTUALLY appears in Claude today'.", status: "in_progress", priority: "urgent", assigneeAgentId: gravSales.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjEnterprise.id, goalId: gravGoalPilots.id, title: "Close 3 pilots this month", description: "$25k–$50k ACV, 3-month pilot → 12-month contract pathway.", status: "in_progress", priority: "urgent", assigneeAgentId: gravSales.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjBench.id, goalId: gravGoalBench.id, title: "Prompt set: 50 brand-intent questions × 4 verticals", description: "DTC, fintech, SaaS, travel. 200 prompts total.", status: "in_progress", priority: "high", assigneeAgentId: gravResearch.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjBench.id, goalId: gravGoalBench.id, title: "Run crawler across 200 brands × 4 LLMs", description: "~4000 queries. Collect + normalize citation outputs.", status: "todo", priority: "high", assigneeAgentId: gravResearch.id, createdByAgentId: gravCTO.id },
  { companyId: gravton.id, projectId: gravProjCategory.id, goalId: gravGoalCategory.id, title: "Cornerstone essay: 'What is GEO?'", description: "3000 words. Define the terms. Cite our own benchmark.", status: "done", priority: "high", assigneeAgentId: gravContent.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjCategory.id, goalId: gravGoalCategory.id, title: "Podcast circuit (10 shows in 30 days)", description: "Latent Space, Lenny's, a16z, SaaStr… Rohan as primary guest.", status: "in_progress", priority: "medium", assigneeAgentId: gravContent.id, createdByAgentId: gravCEO.id },
  { companyId: gravton.id, projectId: gravProjCategory.id, goalId: gravGoalCategory.id, title: "Weekly newsletter: 'How LLMs answered this week'", description: "Curated + commentary on 5 interesting LLM answers. Target 5k subs in Q2.", status: "in_progress", priority: "medium", assigneeAgentId: gravContent.id, createdByAgentId: gravGrowth.id },
);

// Insert all issues
for (const seed of allIssueSeeds) {
  await db.insert(issues).values({
    ...seed,
    startedAt: seed.status !== "backlog" && seed.status !== "todo"
      ? new Date(Date.now() - Math.random() * 4 * 86_400_000)
      : null,
    completedAt: seed.status === "done"
      ? new Date(Date.now() - Math.random() * 2 * 86_400_000)
      : null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Activity log — 60 events across all 3 companies (last 48 hrs)
// ──────────────────────────────────────────────────────────────────────────
const activityTemplates: Array<{ companyId: string; agent: { id: string }; action: string; entityType: string; detail: string }> = [
  // agnost.ai
  { companyId: agnost.id, agent: agnostCEO, action: "essay.published", entityType: "post", detail: "'The eval is the product' — live on blog, 2.1k views in first hour." },
  { companyId: agnost.id, agent: agnostEvals, action: "benchmark.completed", entityType: "benchmark", detail: "SWE-bench-Live run #47 complete. Claude 4.7 Opus: 68.2% (+2.1pp WoW)." },
  { companyId: agnost.id, agent: agnostCTO, action: "pr.merged", entityType: "pr", detail: "eval-harness #124: Gemini 2.5 adapter + streaming tool use. Merged." },
  { companyId: agnost.id, agent: agnostBD, action: "meeting.booked", entityType: "meeting", detail: "Intro call with Anthropic applied-eval team, Thu 3pm PT." },
  { companyId: agnost.id, agent: agnostGrowth, action: "waitlist.milestone", entityType: "milestone", detail: "Waitlist crossed 2,500 (from 500 four weeks ago)." },
  { companyId: agnost.id, agent: agnostContent, action: "doc.updated", entityType: "docs", detail: "Quickstart now under 90 seconds to first eval. Measured on fresh Mac." },
  { companyId: agnost.id, agent: agnostCoS, action: "decision.logged", entityType: "decision", detail: "Approved: open-source MIT for harness. Commercial rubrics stay closed-source." },
  // Pred
  { companyId: pred.id, agent: predCEO, action: "investor.meeting", entityType: "meeting", detail: "Partner call at Accel — engaged on Series A narrative, DD requested." },
  { companyId: pred.id, agent: predCTO, action: "deploy.completed", entityType: "deploy", detail: "Matching engine v3 → prod. Sub-200ms market response on Sportradar goal events, confirmed." },
  { companyId: pred.id, agent: predMarkets, action: "market.listed", entityType: "market", detail: "Liverpool vs Arsenal (GW33): 72 markets, opening liquidity $38K across 1X2 + O/U + BTTS." },
  { companyId: pred.id, agent: predCompliance, action: "policy.update", entityType: "compliance", detail: "Q2 FIU quarterly filing submitted — clean STR-0 return, zero flagged transactions." },
  { companyId: pred.id, agent: predGrowth, action: "partnership.signed", entityType: "partnership", detail: "Signed @statmanDave (UK, 840K followers) — matchday drops start Saturday." },
  { companyId: pred.id, agent: predOps, action: "kyc.queue_cleared", entityType: "ops", detail: "KYC queue cleared in 11h (SLA: 24h). 847 verified overnight." },
  { companyId: pred.id, agent: predCoS, action: "investor.update", entityType: "update", detail: "Q1 investor update draft in Riya's folder. Needs Arjun review." },
  { companyId: pred.id, agent: predContent, action: "content.shipped", entityType: "post", detail: "'How Pred markets actually settle' explainer — 47k IG Reels views in 12 hours." },
  // Gravton
  { companyId: gravton.id, agent: gravCEO, action: "deal.advanced", entityType: "deal", detail: "Warby-Parker pilot — moved from discovery → procurement. $42k ACV." },
  { companyId: gravton.id, agent: gravSales, action: "demo.completed", entityType: "demo", detail: "Demo with Lululemon CMO went 90 minutes (scheduled 30). Follow-up next week." },
  { companyId: gravton.id, agent: gravResearch, action: "report.draft", entityType: "report", detail: "Q2 benchmark draft: 147/200 brands crawled, citation data normalized." },
  { companyId: gravton.id, agent: gravCTO, action: "infra.milestone", entityType: "infra", detail: "Crawler now handles 50k queries/day across 4 LLMs. Rate-limit headroom: 3x." },
  { companyId: gravton.id, agent: gravContent, action: "content.shipped", entityType: "post", detail: "'What is GEO?' live — 18k views, cited by 2 competing vendors already." },
  { companyId: gravton.id, agent: gravGrowth, action: "funnel.update", entityType: "funnel", detail: "Free scanner → paid conversion: 8.2% last 7 days. Target 10%." },
  { companyId: gravton.id, agent: gravCS, action: "renewal.confirmed", entityType: "renewal", detail: "Everlane renewed — $38k, 12 months. Expansion conversation scheduled Q3." },
  { companyId: gravton.id, agent: gravCoS, action: "meeting.prep", entityType: "meeting", detail: "Board deck for April review — first pass in Neha's folder. Rohan review pending." },
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
console.log(`[seed-demo] ✓ Seeded 3 companies:`);
console.log(`           • agnost.ai       — 7 agents, 4 goals, ${allIssueSeeds.filter(i => i.companyId === agnost.id).length} issues`);
console.log(`           • Pred            — 8 agents, 3 goals, ${allIssueSeeds.filter(i => i.companyId === pred.id).length} issues`);
console.log(`           • Gravton Labs    — 8 agents, 4 goals, ${allIssueSeeds.filter(i => i.companyId === gravton.id).length} issues`);
console.log(`           Total: 23 agents, 11 goals, ${allIssueSeeds.length} issues, ${allActivityRows.length} activity events.`);
process.exit(0);
