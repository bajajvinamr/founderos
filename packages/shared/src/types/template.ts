import type { CompanyMetrics } from "./company.js";

/**
 * The set of adapter types FounderOS knows how to configure from a template.
 * Each corresponds to a package under `packages/adapters/*` on the server.
 *
 *   - claude_local  → Claude Code CLI (via user's subscription OR ANTHROPIC_API_KEY)
 *   - codex_local   → OpenAI Codex CLI (via user's subscription OR OPENAI_API_KEY)
 *   - openai_api    → OpenAI direct API (API key required)
 *   - gemini_local  → Gemini CLI (via user's subscription OR GEMINI_API_KEY)
 *   - cursor_local  → Cursor CLI (via user's subscription)
 *   - opencode_local→ OpenCode CLI
 *   - openclaw_gateway → OpenClaw gateway (remote)
 *
 * Note: There is NO `claude_api` adapter. Pre-BYO-108 the type referenced
 * one but no adapter package was ever shipped — agents minted with that
 * type were permanently non-functional. Anthropic execution always goes
 * through `claude_local` (which itself can use ANTHROPIC_API_KEY internally
 * if no CLI auth is present).
 */
export type FounderOSAdapterType =
  | "claude_local"
  | "codex_local"
  | "openai_api"
  | "gemini_local"
  | "cursor_local"
  | "opencode_local"
  | "openclaw_gateway";

export type ProviderFamily = "anthropic" | "openai" | "google" | "other";

/**
 * A template declares which *family* of providers an agent should ideally use
 * (e.g., "reasoning → Anthropic Opus" vs "bulk → OpenAI gpt-5-mini"). The
 * spawn service maps family → concrete adapter_type + model based on what
 * credentials the user has set up.
 */
export type AgentProviderPreference = {
  /** Preferred provider family for this agent, in priority order. */
  families: ProviderFamily[];
  /**
   * Per-family suggested model ids. The spawn service picks the model whose
   * family matches the resolved adapter.
   */
  suggestedModels: Partial<Record<ProviderFamily, string>>;
  /**
   * Preferred execution: "cli" uses the local CLI adapter (claude_local etc.)
   * which leverages the user's subscription OAuth; "api" uses the direct API
   * adapter which bills per-token.
   */
  preferredExecution: "cli" | "api" | "either";
};

/**
 * A FounderOS company template — the blueprint a user picks in onboarding
 * to spin up a fully-wired company in one action.
 *
 * Templates encode:
 *  - The pitch + metadata for the picker UI
 *  - Suggested starting metrics for the Dashboard Pulse widget
 *  - The full agent roster with task-oriented prompts, reports-to wiring,
 *    and budget allocation
 *  - Starter goals + projects + a few first issues so the Inbox is not empty
 *  - Default adapter (claude_local unless overridden)
 *
 * All prompts are task-oriented, not identity-based, so agents actually DO
 * work on heartbeat rather than refusing role-play.
 */

export type TemplateAgentSeed = {
  /** Stable key used for reports-to references within this template. */
  key: string;
  name: string;
  role: string;
  title: string;
  icon?: string;
  /** Key of another agent this one reports to. Omit for direct reports to CEO / no parent. */
  reportsTo?: string;
  /** Monthly USD budget cap for agent spend. */
  budgetUsd: number;
  /** Short human description surfaced on the agent page. */
  capabilities: string;
  /**
   * Task-oriented heartbeat prompt. Should describe the concrete work the
   * agent performs when woken up, NOT their identity. Example:
   *
   *   "Each heartbeat: 1) read open_issues assigned to you, 2) pick the
   *    highest-priority one and continue it, 3) if nothing is open, write
   *    one concrete next step toward goal G and file it as an issue."
   */
  heartbeatPrompt: string;
  /**
   * Provider preference for this agent. The spawn service resolves this to
   * a concrete adapter_type + model based on the user's configured
   * credentials. See AgentProviderPreference for the full shape.
   */
  provider?: AgentProviderPreference;
  /** Max turns per run (defaults to 30). */
  maxTurnsPerRun?: number;
};

export type TemplateGoalSeed = {
  key: string;
  title: string;
  description: string;
  /** Agent key that owns this goal. */
  ownerKey: string;
};

export type TemplateProjectSeed = {
  key: string;
  name: string;
  description: string;
  /** Goal key this project rolls up to. */
  goalKey: string;
  /** Agent key that leads this project. */
  leadKey: string;
};

export type TemplateIssueSeed = {
  projectKey: string;
  title: string;
  description: string;
  status?: "backlog" | "todo" | "in_progress";
  priority?: "low" | "medium" | "high" | "urgent";
  /** Agent key to assign. */
  assigneeKey?: string;
};

export interface CompanyTemplate {
  /** Stable slug used in URLs + API. Example: "solo-indie-saas-founder". */
  id: string;
  /** Human-facing name. */
  name: string;
  /** One-line pitch for the template-picker card. */
  tagline: string;
  /** 2–3 sentence description. */
  summary: string;
  /** Icon/emoji for the picker card. */
  icon: string;
  /** Suggested starting metrics — user can edit after spawn. */
  metrics: CompanyMetrics;
  /** Suggested issue prefix (3 uppercase chars). */
  issuePrefix: string;
  /** Suggested monthly budget in USD for the whole company. */
  budgetUsd: number;
  /** Best-fit category for filtering. */
  category: "solo_founder" | "ai_lab" | "b2b_saas" | "consumer" | "custom";
  /** Agent roster. First agent is the CEO-of-company (no reportsTo). */
  agents: TemplateAgentSeed[];
  goals: TemplateGoalSeed[];
  projects: TemplateProjectSeed[];
  issues: TemplateIssueSeed[];
}

export type TemplateSummary = Pick<
  CompanyTemplate,
  "id" | "name" | "tagline" | "summary" | "icon" | "category"
> & {
  agentCount: number;
  goalCount: number;
  projectCount: number;
};

export function summarizeTemplate(t: CompanyTemplate): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    summary: t.summary,
    icon: t.icon,
    category: t.category,
    agentCount: t.agents.length,
    goalCount: t.goals.length,
    projectCount: t.projects.length,
  };
}
