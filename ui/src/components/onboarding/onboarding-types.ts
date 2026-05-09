/**
 * FounderOS onboarding (v2) — shared state types.
 *
 * The new wizard is an opinionated 6-step founder flow. Everything typed
 * here is client-only; we serialise a flat `OnboardingBootstrapPayload`
 * over the wire when the founder advances past "Plug in your brain".
 */

import {
  ONBOARDING_ADAPTER_CHOICES,
  ONBOARDING_CLI_CHOICES,
  type OnboardingAdapterChoice,
  type OnboardingCliChoice,
} from "@founderos/shared";

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

/**
 * S1.9 — Department picker. The 5 core departments (chief-of-staff,
 * growth, content, crm, finance) are always-on by business rule. The
 * founder can opt in to non-core departments (engineering, ops) and
 * pick a workspace-wide autonomy level for v1. Server expands this
 * into per-department `workspace_departments` rows.
 */
export const NON_CORE_DEPARTMENTS = ["engineering", "ops"] as const;
export type NonCoreDepartmentId = (typeof NON_CORE_DEPARTMENTS)[number];

export const NON_CORE_DEPARTMENT_LABELS: Record<NonCoreDepartmentId, string> = {
  engineering: "Engineering",
  ops: "Operations",
};

export const NON_CORE_DEPARTMENT_DESCRIPTIONS: Record<NonCoreDepartmentId, string> = {
  engineering: "Product, PRs, reviews, infra",
  ops: "Workflows, approvals, SOPs",
};

export const AUTONOMY_LEVELS = [1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, { label: string; sublabel: string }> = {
  1: { label: "Advisory only", sublabel: "Agents draft, you decide everything." },
  2: { label: "Approval-first", sublabel: "Agents act after you approve. (Recommended)" },
  3: { label: "Auto-execute safe tasks", sublabel: "Routine work runs; risky calls escalate." },
  4: { label: "Fully autonomous", sublabel: "Agents act without approval. Advanced." },
};

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
 * Where the agent's LLM auth comes from at onboarding.
 *
 * S7.0.2 (multi-CLI runner sprint, 2026-05-07) — widened from the
 * Claude-only triplet to the full set of CLI adapters the @founderos/runner
 * dispatcher will support post-S7.A. Until S7.4 ships the wider UI picker,
 * the wizard surfaces only `claude_local` / `anthropic_api` / `skip`; the
 * schema is purposely wider so a future UI revision can pass any of the
 * 7 CLI choices without an API change.
 *
 * Canonical list lives in `@founderos/shared` so the UI and server
 * Zod enum stay locked together. See the docstring on
 * `ONBOARDING_ADAPTER_CHOICES` for per-value semantics.
 */
export const ADAPTER_CHOICES = ONBOARDING_ADAPTER_CHOICES;
export type AdapterChoice = OnboardingAdapterChoice;

export const CLI_ADAPTER_CHOICES = ONBOARDING_CLI_CHOICES;
export type CliAdapterChoice = OnboardingCliChoice;

export function isCliAdapterChoice(choice: AdapterChoice): choice is CliAdapterChoice {
  return (CLI_ADAPTER_CHOICES as readonly string[]).includes(choice);
}

export interface OnboardingDraft {
  vision: string;
  bottlenecks: Bottleneck[];
  team: TeamShape;
  cofounderName: string;
  cofounderEmail: string;
  adapterChoice: AdapterChoice;
  anthropicKey: string;
  integrations: Record<IntegrationKey, boolean>;
  /** S1.9 — non-core departments the founder opted in to. Core 5 always on. */
  nonCoreDepartments: NonCoreDepartmentId[];
  /** S1.9 — workspace-wide autonomy level for all enabled departments. */
  autonomyLevel: AutonomyLevel;
  charters: AgentCharterMap;
  firstDecisionId: string | null;
  /**
   * S-TC1 — Telemetry consent. Default false (council 2026-05-05 P1 fix).
   * The founder must explicitly tap "Allow anonymous telemetry" on the
   * dedicated step at the end of the wizard for this to flip true.
   */
  telemetryEnabled: boolean;
}

export interface OnboardingBootstrapResponse {
  companyId: string;
  companyPrefix: string;
  /** IDs of the 4 provisioned agents, keyed by slot. */
  agentIdsBySlot: Record<AgentSlot, string>;
  goalId: string | null;
  projectId: string | null;
}

export const DEFAULT_NON_CORE_DEPARTMENTS: NonCoreDepartmentId[] = [];
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 2;

export const DEFAULT_INTEGRATION_STATE: Record<IntegrationKey, boolean> =
  INTEGRATION_KEYS.reduce(
    (acc, key) => {
      acc[key] = false;
      return acc;
    },
    {} as Record<IntegrationKey, boolean>,
  );
