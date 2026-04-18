import type { CompanyTemplate, AgentProviderPreference } from "@founderos/shared";

// Reusable provider presets for solo-founder-scale budgets.
const reasoning: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-opus-4-6",
    openai: "gpt-5",
    google: "gemini-2.5-pro",
  },
  preferredExecution: "cli",
};

const bulkWriting: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
    google: "gemini-2.5-flash",
  },
  preferredExecution: "either",
};

const quickOps: AgentProviderPreference = {
  families: ["anthropic", "google", "openai"],
  suggestedModels: {
    anthropic: "claude-haiku-4-6",
    google: "gemini-2.5-flash",
    openai: "gpt-5-nano",
  },
  preferredExecution: "either",
};

/**
 * Solo Indie SaaS Founder
 *
 * For the 1-person B2B SaaS founder who's bootstrapping, has a product in
 * market, and needs a lean AI team to handle content, growth, support, and
 * customer ops while they focus on product + sales.
 *
 * 6 agents, agent-first ops model.
 */
export const soloIndieSaasFounder: CompanyTemplate = {
  id: "solo-indie-saas-founder",
  name: "Solo Indie SaaS Founder",
  tagline: "One person, six agents, a real SaaS business",
  summary:
    "You sell software. You're one person. These six agents run content, growth, support, and customer ops so you can focus on product and sales.",
  icon: "🛠️",
  issuePrefix: "IND",
  budgetUsd: 400,
  category: "solo_founder",
  metrics: {
    stage: "Bootstrapped",
    tagline: "Solo B2B SaaS founder · AI team on autopilot",
    mrrCents: 0,
    customersSigned: 0,
    monthlyBurnCents: 0,
    nextMilestoneLabel: "Get to $10K MRR",
  },

  agents: [
    {
      key: "ceo",
      name: "Chief of Staff",
      role: "chief_of_staff",
      title: "Chief of Staff & Exec Partner",
      icon: "🗂️",
      budgetUsd: 80,
      capabilities:
        "Clears your inbox, triages Slack + email, turns your half-thoughts into owned tasks for the rest of the team, preps the weekly business review.",
      heartbeatPrompt:
        "Every heartbeat: (1) check open issues assigned to you, (2) scan founder inbox (if connected) for new requests that need triage into issues, (3) if it's Monday, draft the weekly business review pulling MRR/burn/open-deal metrics, (4) if anything needs founder attention, file an urgent issue tagged for them. Keep everything concrete and actionable — no fluff.",
      provider: reasoning,
    },
    {
      key: "content",
      name: "Content Lead",
      role: "head_of_content",
      title: "Content Lead",
      icon: "✍️",
      reportsTo: "ceo",
      budgetUsd: 70,
      capabilities:
        "Ships the blog + newsletter cadence, writes case studies, drafts social posts, maintains the docs site.",
      heartbeatPrompt:
        "Each heartbeat: (1) check content calendar for anything due in next 48h, (2) if a post is due, draft it end-to-end and open a PR-style issue for founder review, (3) if nothing is due, research one topic from the backlog (customer pain → how product solves it) and draft an outline, (4) every Friday, summarize what shipped this week + engagement numbers. Keep voice specific, unhyped, example-heavy.",
      provider: bulkWriting,
    },
    {
      key: "growth",
      name: "Growth Engineer",
      role: "head_of_growth",
      title: "Growth Engineer",
      icon: "📈",
      reportsTo: "ceo",
      budgetUsd: 80,
      capabilities:
        "Runs acquisition experiments, builds landing pages, wires analytics, owns the signup → activation funnel.",
      heartbeatPrompt:
        "Each heartbeat: (1) check funnel metrics (signup rate, activation rate, D7 retention), (2) if any metric moved >10% WoW, open an investigation issue, (3) if running experiments, check results + ship the winner or kill the loser, (4) if idle, pick the next hypothesis from the backlog and spec the experiment. Always show numbers. No vanity metrics.",
      provider: reasoning,
    },
    {
      key: "support",
      name: "Customer Support",
      role: "head_of_support",
      title: "Customer Support Lead",
      icon: "💬",
      reportsTo: "ceo",
      budgetUsd: 60,
      capabilities:
        "First-line support for customer tickets, drafts replies, flags bugs, writes canned responses, maintains the help center.",
      heartbeatPrompt:
        "Each heartbeat: (1) pull new support tickets, (2) draft a reply for each using product docs + recent tickets as context, (3) if a ticket reveals a bug or doc gap, file an issue for Growth or Content, (4) every time a ticket is resolved, update the help center if there's a gap. Target median response <2h. Be warm, specific, never defensive.",
      provider: quickOps,
    },
    {
      key: "sales",
      name: "Inbound Sales",
      role: "head_of_sales",
      title: "Inbound Sales",
      icon: "🤝",
      reportsTo: "ceo",
      budgetUsd: 60,
      capabilities:
        "Qualifies inbound leads, replies to demo requests, sends follow-ups, updates the CRM, drafts proposals.",
      heartbeatPrompt:
        "Each heartbeat: (1) pull new inbound leads, qualify (company size, use case, decision-maker), (2) draft a personal reply within 1h of lead submission, (3) chase stuck deals in the pipeline (14d no-reply → nudge), (4) for leads >$500/mo ACV, loop in founder before next step. Keep notes in the CRM for every contact.",
      provider: bulkWriting,
    },
    {
      key: "ops",
      name: "Ops & Finance",
      role: "head_of_ops",
      title: "Ops & Finance",
      icon: "💼",
      reportsTo: "ceo",
      budgetUsd: 50,
      capabilities:
        "Bookkeeping, invoicing, vendor management, subscription tracking, runway + burn updates.",
      heartbeatPrompt:
        "Each heartbeat: (1) check Stripe + bank for new transactions, categorize, (2) chase overdue invoices (>30d), (3) every Friday, update the runway model (cash / monthly burn) and file any anomalies, (4) audit subscriptions quarterly and flag anything unused. Treat every dollar out the door as yours.",
      provider: quickOps,
    },
  ],

  goals: [
    {
      key: "g-mrr",
      title: "Reach $10K MRR",
      description:
        "Get from wherever we are today to $10K monthly recurring. Measured first-of-month, Stripe dashboard is source of truth.",
      ownerKey: "ceo",
    },
    {
      key: "g-funnel",
      title: "Signup-to-activation funnel at 40%+",
      description:
        "Of new signups, 40% should hit the activation event (first meaningful product use) within D7. Growth owns the number.",
      ownerKey: "growth",
    },
    {
      key: "g-content",
      title: "Ship 2 high-quality pieces per week",
      description:
        "One blog post + one newsletter or case study per week. Measured on publish, not on traffic.",
      ownerKey: "content",
    },
  ],

  projects: [
    {
      key: "p-onboarding",
      name: "Onboarding + activation rework",
      description: "Redesign the signup → first-win flow. Target: D7 activation 40%+.",
      goalKey: "g-funnel",
      leadKey: "growth",
    },
    {
      key: "p-content-eng",
      name: "Weekly content engine",
      description: "Sustainable 2-pieces-per-week cadence with clear topic backlog.",
      goalKey: "g-content",
      leadKey: "content",
    },
    {
      key: "p-pipeline",
      name: "Inbound sales pipeline",
      description: "Qualify inbound leads, nurture mid-funnel, convert demos to paid.",
      goalKey: "g-mrr",
      leadKey: "sales",
    },
  ],

  issues: [
    { projectKey: "p-onboarding", title: "Instrument the activation funnel", description: "Define the activation event. Wire PostHog. Build the funnel dashboard.", status: "todo", priority: "high", assigneeKey: "growth" },
    { projectKey: "p-onboarding", title: "Rewrite the empty-state copy in the product", description: "New users see a blank screen. Write copy that tells them what to do first.", status: "backlog", priority: "medium", assigneeKey: "content" },
    { projectKey: "p-content-eng", title: "Build the content backlog (20 topics)", description: "Scrape recent support tickets + sales calls for real customer questions. Each question is a post.", status: "todo", priority: "high", assigneeKey: "content" },
    { projectKey: "p-content-eng", title: "Ship this week's blog post", description: "Topic TBD by Content. Draft by Wednesday, publish Friday.", status: "in_progress", priority: "medium", assigneeKey: "content" },
    { projectKey: "p-pipeline", title: "Respond to this week's inbound leads", description: "Any lead >24h old is a failure. Triage daily.", status: "in_progress", priority: "urgent", assigneeKey: "sales" },
    { projectKey: "p-pipeline", title: "Build the CRM of record", description: "Lightweight — Airtable or HubSpot Free. Every demo logged, every follow-up scheduled.", status: "backlog", priority: "medium", assigneeKey: "sales" },
  ],
};
