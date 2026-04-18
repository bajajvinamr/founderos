import type { CompanyTemplate, AgentProviderPreference } from "@founderos/shared";

// Provider presets for research-lab scale budgets. Leans heavier on opus
// because eval work benefits from deeper reasoning.
const deepReasoning: AgentProviderPreference = {
  families: ["anthropic", "openai"],
  suggestedModels: {
    anthropic: "claude-opus-4-6",
    openai: "gpt-5",
  },
  preferredExecution: "cli",
};

const researchOps: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
    google: "gemini-2.5-pro",
  },
  preferredExecution: "either",
};

const writing: AgentProviderPreference = {
  families: ["anthropic", "openai"],
  suggestedModels: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
  },
  preferredExecution: "either",
};

/**
 * Pre-seed AI Lab
 *
 * For the technical founder building AI tooling / research at pre-seed stage.
 * Eval-first, design-partner-driven, public writing as the growth motor.
 * Modeled on how agnost.ai actually operates.
 */
export const preseedAiLab: CompanyTemplate = {
  id: "preseed-ai-lab",
  name: "Pre-seed AI Lab",
  tagline: "Research-lean AI shop chasing first design partners",
  summary:
    "You're building AI tooling. You have a thesis and 6 months of pre-seed. You need design partners, papers, and a fundraise pipeline. These agents handle the research ops + BD + writing.",
  icon: "🔬",
  issuePrefix: "LAB",
  budgetUsd: 900,
  category: "ai_lab",
  metrics: {
    stage: "Pre-seed",
    tagline: "Pre-seed AI research · designing partners now · seed round next",
    fundingRaisedCents: 0,
    customersSigned: 0,
    pipelineCount: 0,
    monthlyBurnCents: 0,
    nextMilestoneLabel: "5 design partners + seed round",
  },

  agents: [
    {
      key: "ceo",
      name: "Chief of Staff",
      role: "chief_of_staff",
      title: "Chief of Staff & Research Ops",
      icon: "🗂️",
      budgetUsd: 120,
      capabilities:
        "Runs the weekly rhythm, converts founder's half-formed research threads into owned experiments, preps fundraise materials, drafts investor updates.",
      heartbeatPrompt:
        "Each heartbeat: (1) review open issues + check project timelines, (2) if a project has stalled 3+ days, open a nudge issue + propose an unblocker, (3) if new research ideas were logged this week, convert them to scoped experiments in the backlog, (4) every other Friday, draft the investor update (what shipped / what's next / ask). Be dense, specific, evidence-first.",
      provider: researchOps,
    },
    {
      key: "evals",
      name: "Evals Lead",
      role: "head_of_evals",
      title: "Evals & Research Engineer",
      icon: "📏",
      reportsTo: "ceo",
      budgetUsd: 240,
      capabilities:
        "Designs rubrics, builds benchmark harnesses, runs evals, writes up results.",
      heartbeatPrompt:
        "Each heartbeat: (1) check running benchmark jobs + report completions, (2) if a new model was released in the last 24h, queue a benchmark run against our rubric suite, (3) if idle, pick the next rubric from the research agenda and draft the grader, (4) every time an eval completes, write a 5-line summary + file the data. Reproducibility bar: another lab could re-run your exact protocol in 2 hours.",
      provider: deepReasoning,
    },
    {
      key: "bd",
      name: "Biz Dev",
      role: "head_of_bd",
      title: "BD & Partnerships",
      icon: "🤝",
      reportsTo: "ceo",
      budgetUsd: 140,
      capabilities:
        "Outreach to frontier labs, books design-partner calls, drafts partnership MoUs, follows up on warm leads.",
      heartbeatPrompt:
        "Each heartbeat: (1) check target-account list + move stale conversations forward (7d no-reply → nudge), (2) if founder asked for an intro, draft the email + find the right path (mutual connections, LinkedIn), (3) every week, propose 5 new target accounts based on recent papers + hires, (4) on every design-partner call, write the 3-line summary + log the next step. Never cold-pitch — always lead with value (a custom benchmark on their agents, a specific insight).",
      provider: writing,
    },
    {
      key: "writer",
      name: "Technical Writer",
      role: "head_of_content",
      title: "Technical Writer",
      icon: "✍️",
      reportsTo: "ceo",
      budgetUsd: 100,
      capabilities:
        "Ghostwrites the founder's essays, writes benchmark blog posts, maintains arXiv preprints, edits for technical precision.",
      heartbeatPrompt:
        "Each heartbeat: (1) check for new eval results that deserve a public writeup, (2) if any are ready, draft the blog post (methodology → data → interpretation → caveats), (3) if idle, polish a backlog draft, (4) every time an essay is published, log HN/Twitter/LinkedIn reactions for the growth dashboard. Voice: precise, unhyped, every claim linked to data. No marketing fluff.",
      provider: writing,
    },
    {
      key: "growth",
      name: "DevRel & Growth",
      role: "head_of_growth",
      title: "DevRel & Community",
      icon: "📈",
      reportsTo: "ceo",
      budgetUsd: 120,
      capabilities:
        "Runs the waitlist, owns the Discord, books conference talks, manages social presence.",
      heartbeatPrompt:
        "Each heartbeat: (1) triage Discord + Twitter mentions, reply to questions or escalate, (2) if a blog post shipped in the last 48h, coordinate a distribution push (HN, Twitter, LW), (3) track waitlist growth, flag any day with <normal signups, (4) every Friday, propose 1 new distribution experiment. Our buyer is a research engineer — write for them.",
      provider: researchOps,
    },
    {
      key: "cto",
      name: "Research Eng Lead",
      role: "cto",
      title: "Research Engineering",
      icon: "🔧",
      reportsTo: "ceo",
      budgetUsd: 200,
      capabilities:
        "Infra for evals (Modal/Ray), adapter plumbing for different model providers, reproducibility tooling, incident response.",
      heartbeatPrompt:
        "Each heartbeat: (1) check CI + eval-harness pipeline health, (2) if a benchmark broke, drop everything and investigate, (3) if idle, pick the next engineering debt item (cost is our biggest risk — unused compute, leaking keys, lazy caching), (4) every PR review <24h. The bar: can another lab replicate our setup in 2 weeks?",
      provider: deepReasoning,
    },
  ],

  goals: [
    {
      key: "g-partners",
      title: "Sign 5 design partners",
      description:
        "Paying design-partner contracts at $2–5K/mo with frontier labs. BD owns. Bar: real access to their agent logs + quarterly eval reports.",
      ownerKey: "bd",
    },
    {
      key: "g-papers",
      title: "Publish 3 eval benchmarks",
      description:
        "Each benchmark ships as an arXiv paper + blog post + reproducible notebook. Quarterly cadence.",
      ownerKey: "evals",
    },
    {
      key: "g-seed",
      title: "Close a $3M seed round",
      description:
        "Target lead in 8 months. Build the memo + metrics + warm-intro list now; fundraise sprint in month 6.",
      ownerKey: "ceo",
    },
  ],

  projects: [
    {
      key: "p-harness",
      name: "Eval harness v1",
      description: "Open-source Python harness + adapters for claude/gpt/gemini. CLI + pytest plugin. This is the product wedge.",
      goalKey: "g-papers",
      leadKey: "cto",
    },
    {
      key: "p-dp",
      name: "Design partner pipeline",
      description: "30 target labs → 10 first calls → 5 signed MoUs.",
      goalKey: "g-partners",
      leadKey: "bd",
    },
    {
      key: "p-thesis",
      name: "Public thesis engine",
      description: "Bi-weekly essay + benchmark cadence. Drives waitlist + credibility.",
      goalKey: "g-partners",
      leadKey: "writer",
    },
  ],

  issues: [
    { projectKey: "p-harness", title: "Ship unified adapter API across 3 providers", description: "One interface → Claude, GPT, Gemini. Handle streaming + tool-use. Public repo.", status: "in_progress", priority: "urgent", assigneeKey: "cto" },
    { projectKey: "p-harness", title: "Build the first rubric (pass/fail) + grader", description: "Minimal binary grader. We can always add dimensions later.", status: "todo", priority: "high", assigneeKey: "evals" },
    { projectKey: "p-harness", title: "Write the README + quickstart", description: "30-second install → first eval. Measured on a fresh machine.", status: "backlog", priority: "high", assigneeKey: "writer" },
    { projectKey: "p-dp", title: "Build the 30-account target list", description: "Applied research leads at frontier labs + top AI products. Include context on their current eval setup.", status: "todo", priority: "high", assigneeKey: "bd" },
    { projectKey: "p-dp", title: "Draft the design-partner MoU template", description: "Monthly fee + log access + joint blog post clause. Draft once, reuse.", status: "backlog", priority: "medium", assigneeKey: "ceo" },
    { projectKey: "p-thesis", title: "Write the founding thesis essay", description: "What we believe about agent evaluation that's non-consensus. Target: HN front page.", status: "in_progress", priority: "high", assigneeKey: "writer" },
    { projectKey: "p-thesis", title: "Set up the blog + newsletter infrastructure", description: "Custom domain, email capture, analytics. Boring but needed.", status: "backlog", priority: "medium", assigneeKey: "growth" },
  ],
};
