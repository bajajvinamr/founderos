import type { CompanyTemplate, AgentProviderPreference } from "@founderos/shared";

// B2B SaaS presets — sales-heavy, so mix of deep reasoning for CEO/CTO and
// solid writing models for sales + content.
const reasoning: AgentProviderPreference = {
  families: ["anthropic", "openai"],
  suggestedModels: {
    anthropic: "claude-opus-4-6",
    openai: "gpt-5",
  },
  preferredExecution: "cli",
};

const salesWriting: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
    google: "gemini-2.5-pro",
  },
  preferredExecution: "either",
};

const ops: AgentProviderPreference = {
  families: ["anthropic", "google", "openai"],
  suggestedModels: {
    anthropic: "claude-haiku-4-6",
    google: "gemini-2.5-flash",
    openai: "gpt-5-nano",
  },
  preferredExecution: "either",
};

/**
 * Bootstrapped B2B SaaS
 *
 * For the founder(s) who've validated the product, are closing pilots, and
 * need a go-to-market engine without raising yet. Heavier on sales + CS,
 * lighter on research. Modeled on how Gravton Labs operates.
 */
export const bootstrappedB2bSaas: CompanyTemplate = {
  id: "bootstrapped-b2b-saas",
  name: "Bootstrapped B2B SaaS",
  tagline: "Pilots in the pipeline, raising soon, running lean",
  summary:
    "You have product-market fit signal (enterprise pilots closing) but you haven't raised. Your agents are the sales + CS + marketing team: qualifying demand, closing deals, retaining pilots, writing the category.",
  icon: "🏢",
  issuePrefix: "B2B",
  budgetUsd: 1200,
  category: "b2b_saas",
  metrics: {
    stage: "Bootstrapped · Raising",
    tagline: "B2B SaaS · pilot-led · category creation play",
    pipelineCount: 0,
    customersSigned: 0,
    monthlyBurnCents: 0,
    nextMilestoneLabel: "Close first round",
  },

  agents: [
    {
      key: "ceo",
      name: "Chief of Staff",
      role: "chief_of_staff",
      title: "Chief of Staff & Board Prep",
      icon: "🗂️",
      budgetUsd: 120,
      capabilities:
        "Runs the exec cadence, preps board decks, drafts investor updates, owns the weekly pipeline review, escalates blockers to founders.",
      heartbeatPrompt:
        "Each heartbeat: (1) check pipeline health (stuck deals, at-risk renewals), (2) if it's Monday, draft the weekly pipeline review, (3) if it's the first of the month, draft the monthly investor update (ARR / pipeline / key wins / ask), (4) every board meeting, coordinate prep 2 weeks out. Always surface the 2-3 most important things; never bury the lede.",
      provider: reasoning,
    },
    {
      key: "sales",
      name: "Enterprise AE",
      role: "head_of_sales",
      title: "Head of Enterprise Sales",
      icon: "🤝",
      reportsTo: "ceo",
      budgetUsd: 240,
      capabilities:
        "Runs the enterprise pipeline, prospects top accounts, delivers demos, navigates procurement, closes pilots → annual contracts.",
      heartbeatPrompt:
        "Each heartbeat: (1) review all deals in flight, advance each by one concrete step, (2) if a demo happened in last 24h, send the follow-up within 2h, (3) every deal >30 days in same stage → open a 'stuck deal' issue with 3 options to unstick, (4) every Friday, update pipeline numbers. Never forecast higher than you'd bet your own money on.",
      provider: salesWriting,
    },
    {
      key: "cs",
      name: "Customer Success",
      role: "head_of_cs",
      title: "Head of Customer Success",
      icon: "💬",
      reportsTo: "ceo",
      budgetUsd: 180,
      capabilities:
        "Owns pilot → paid conversion, writes monthly exec reports for each customer, handles renewals, flags churn risks.",
      heartbeatPrompt:
        "Each heartbeat: (1) for each active pilot, check usage + health score, (2) if any account used the product <3x this week, flag at-risk + draft outreach, (3) on the 1st of the month, draft each customer's monthly exec report (usage, ROI, recommendations), (4) 60 days before renewal, open the renewal project. Every customer gets QBR'd.",
      provider: salesWriting,
    },
    {
      key: "growth",
      name: "Growth Lead",
      role: "head_of_growth",
      title: "Demand Gen + Self-Serve Growth",
      icon: "📈",
      reportsTo: "ceo",
      budgetUsd: 180,
      capabilities:
        "Runs paid + organic demand gen, owns the free-tier → paid funnel, manages the PLG experiment queue, partners with sales on ABM.",
      heartbeatPrompt:
        "Each heartbeat: (1) check funnel metrics (MQLs, SQLs, paid signups), (2) if any channel's CAC moved >20%, investigate + ship adjustment, (3) every week, propose 1 ABM experiment targeting top-10 named accounts for sales, (4) monthly, build the marketing → revenue attribution report. No vanity metrics; always follow the dollar.",
      provider: reasoning,
    },
    {
      key: "content",
      name: "Content & Category",
      role: "head_of_content",
      title: "Content + Category Lead",
      icon: "✍️",
      reportsTo: "growth",
      budgetUsd: 160,
      capabilities:
        "Owns the category-defining essays + weekly newsletter + customer case studies + podcast circuit.",
      heartbeatPrompt:
        "Each heartbeat: (1) check content calendar, (2) if a cornerstone essay is due this month, draft it (3000 words, thesis-led, data-backed), (3) if a customer recently hit a milestone, draft their case study, (4) every Monday, ship the weekly newsletter. Voice: we create the category, we don't follow it.",
      provider: salesWriting,
    },
    {
      key: "cto",
      name: "CTO",
      role: "cto",
      title: "CTO & Product",
      icon: "🔧",
      reportsTo: "ceo",
      budgetUsd: 240,
      capabilities:
        "Product roadmap, eng hiring, core infrastructure, incident response, technical sales support for enterprise deals.",
      heartbeatPrompt:
        "Each heartbeat: (1) check deploy + infra health, (2) review PRs in queue (<24h turnaround), (3) if sales needs a custom proof-of-value for a top-10 account, drop everything and scope, (4) every Friday, update the product roadmap with what shipped. Infrastructure that breaks in front of a customer is a company-ending event — treat it that way.",
      provider: reasoning,
    },
    {
      key: "ops",
      name: "Finance & Ops",
      role: "head_of_ops",
      title: "Finance & Ops",
      icon: "💼",
      reportsTo: "ceo",
      budgetUsd: 100,
      capabilities:
        "Monthly close, invoice ops, vendor contracts, headcount planning, runway model, fundraise prep data room.",
      heartbeatPrompt:
        "Each heartbeat: (1) reconcile Stripe + bank, flag any anomalies, (2) chase overdue invoices, (3) on the 5th of each month, close the books + update the runway model, (4) if fundraise is active, keep the data room current every week. The ask: zero surprises on a board call.",
      provider: ops,
    },
  ],

  goals: [
    {
      key: "g-pilots",
      title: "40 pilot customers in flight",
      description:
        "Active pilots with enterprise buyers. 25% → paid conversion target. Sales + CS co-own.",
      ownerKey: "sales",
    },
    {
      key: "g-arr",
      title: "$500K ARR by end of Q4",
      description:
        "Weighted across signed contracts. Monthly progress tracked on dashboard.",
      ownerKey: "sales",
    },
    {
      key: "g-category",
      title: "Own the category term on Google + Perplexity",
      description:
        "Rank page-1 for our core category keyword on Google AND get cited as primary source by Perplexity within 90 days.",
      ownerKey: "content",
    },
    {
      key: "g-round",
      title: "Close the seed round",
      description:
        "Target term sheet in 6 months. Metrics + traction must be fundraise-ready by month 3.",
      ownerKey: "ceo",
    },
  ],

  projects: [
    {
      key: "p-pipeline",
      name: "Enterprise pipeline engine",
      description: "Top-50 target accounts → 20 first meetings → 10 signed pilots per quarter.",
      goalKey: "g-pilots",
      leadKey: "sales",
    },
    {
      key: "p-pilots-to-paid",
      name: "Pilot-to-paid conversion",
      description: "Turn pilots into 12-month contracts with 30%+ expansion. Health scoring + QBRs + exec reports drive retention.",
      goalKey: "g-arr",
      leadKey: "cs",
    },
    {
      key: "p-category",
      name: "Category creation playbook",
      description: "Cornerstone essays + weekly newsletter + podcast circuit. Build the intellectual home of the category.",
      goalKey: "g-category",
      leadKey: "content",
    },
    {
      key: "p-raise",
      name: "Seed round",
      description: "Data room + memo + metrics dashboard + warm-intro list. Sprint in month 4.",
      goalKey: "g-round",
      leadKey: "ceo",
    },
  ],

  issues: [
    { projectKey: "p-pipeline", title: "Build target-50 account list", description: "ICP-matched enterprise prospects ranked by LLM-visibility pain + willingness to pay.", status: "todo", priority: "high", assigneeKey: "sales" },
    { projectKey: "p-pipeline", title: "Draft the demo script + sample output", description: "Every demo starts with showing the prospect their own data. Script it.", status: "in_progress", priority: "urgent", assigneeKey: "sales" },
    { projectKey: "p-pipeline", title: "Close this month's top-3 pipeline deals", description: "Names TBD by AE. Each gets a custom proof-of-value from CTO if warranted.", status: "in_progress", priority: "urgent", assigneeKey: "sales" },
    { projectKey: "p-pilots-to-paid", title: "Build the monthly exec visibility report template", description: "CS deliverable — makes renewals a conversation about ROI, not price.", status: "todo", priority: "high", assigneeKey: "cs" },
    { projectKey: "p-pilots-to-paid", title: "Set up account health scoring", description: "Usage + NPS + exec engagement → green/yellow/red. Auto-open issues for yellow/red.", status: "backlog", priority: "medium", assigneeKey: "cs" },
    { projectKey: "p-category", title: "Ship the cornerstone essay", description: "3000-word thesis piece that defines our category. Our stake in the ground.", status: "in_progress", priority: "high", assigneeKey: "content" },
    { projectKey: "p-category", title: "Book 10 podcast appearances in 30 days", description: "Latent Space, Lenny's, a16z, SaaStr, category-adjacent shows. CEO is primary guest.", status: "todo", priority: "medium", assigneeKey: "content" },
    { projectKey: "p-raise", title: "Draft the seed memo", description: "10 pages. Problem → wedge → traction → team → ask. Ready for partner-meeting circulation.", status: "backlog", priority: "high", assigneeKey: "ceo" },
    { projectKey: "p-raise", title: "Build the metrics dashboard for the data room", description: "ARR, retention cohorts, CAC payback, burn multiple. All live-refreshed.", status: "backlog", priority: "high", assigneeKey: "ops" },
  ],
};
