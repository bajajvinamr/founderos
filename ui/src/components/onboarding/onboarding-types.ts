/**
 * FounderOS onboarding (v2) — shared state types.
 *
 * The new wizard is an opinionated 6-step founder flow. Everything typed
 * here is client-only; we serialise a flat `OnboardingBootstrapPayload`
 * over the wire when the founder advances past "Plug in your brain".
 */

export const BOTTLENECKS = [
  "hiring",
  "growth",
  "content",
  "finance",
  "ops",
  "fundraising",
  "pmf",
] as const;
export type Bottleneck = (typeof BOTTLENECKS)[number];

export const BOTTLENECK_LABELS: Record<Bottleneck, string> = {
  hiring: "Hiring",
  growth: "Growth",
  content: "Content",
  finance: "Finance",
  ops: "Ops",
  fundraising: "Fundraising",
  pmf: "Product-market fit",
};

export const TEAM_SHAPES = ["solo", "cofounder", "small_team"] as const;
export type TeamShape = (typeof TEAM_SHAPES)[number];

export const TEAM_SHAPE_LABELS: Record<TeamShape, string> = {
  solo: "Solo",
  cofounder: "With cofounder",
  small_team: "With small team",
};

export const INTEGRATION_KEYS = [
  "slack",
  "hubspot",
  "notion",
  "posthog",
  "linkedin",
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export const INTEGRATION_LABELS: Record<IntegrationKey, string> = {
  slack: "Slack",
  hubspot: "HubSpot",
  notion: "Notion",
  posthog: "PostHog",
  linkedin: "LinkedIn",
};

/**
 * Canonical agent slots that FounderOS provisions for every new company.
 * Names are user-editable; roles map to the closest valid `AgentRole` enum.
 */
export const AGENT_SLOTS = ["cos", "growth", "content", "finance"] as const;
export type AgentSlot = (typeof AGENT_SLOTS)[number];

export interface AgentCharter {
  slot: AgentSlot;
  /** User-editable display name. */
  name: string;
  /** Short subtitle shown under the name. */
  title: string;
  /** Emoji/text avatar — harmless fallback, not a real image. */
  avatar: string;
  /** 2-sentence description, derived from vision + bottleneck. */
  charter: string;
  /** The first concrete task this agent will run after launch. */
  firstPriority: string;
}

export type AgentCharterMap = Record<AgentSlot, AgentCharter>;

export interface FirstDecisionCard {
  id: string;
  /** The department/agent slot this decision gets assigned to. */
  slot: AgentSlot;
  title: string;
  /** Slightly longer rationale rendered as body on the card. */
  rationale: string;
}

/**
 * Where the agent's Claude auth comes from.
 *   - `claude_local`: user has the Claude Code CLI installed and authed.
 *     The adapter spawns `claude` locally; we never see an API key.
 *     Works for anyone with Claude Pro or a local subscription.
 *   - `anthropic_api`: user provides an sk-ant-... key. Required for
 *     hosted deployments where we can't shell into a local CLI.
 *   - `skip`: set it up later in Settings → Providers.
 */
export const ADAPTER_CHOICES = ["claude_local", "anthropic_api", "skip"] as const;
export type AdapterChoice = (typeof ADAPTER_CHOICES)[number];

export interface OnboardingDraft {
  vision: string;
  bottlenecks: Bottleneck[];
  team: TeamShape;
  cofounderName: string;
  cofounderEmail: string;
  adapterChoice: AdapterChoice;
  anthropicKey: string;
  integrations: Record<IntegrationKey, boolean>;
  charters: AgentCharterMap;
  firstDecisionId: string | null;
}

export interface OnboardingBootstrapResponse {
  companyId: string;
  companyPrefix: string;
  /** IDs of the 4 provisioned agents, keyed by slot. */
  agentIdsBySlot: Record<AgentSlot, string>;
  goalId: string | null;
  projectId: string | null;
}

export const DEFAULT_INTEGRATION_STATE: Record<IntegrationKey, boolean> =
  INTEGRATION_KEYS.reduce(
    (acc, key) => {
      acc[key] = false;
      return acc;
    },
    {} as Record<IntegrationKey, boolean>,
  );
