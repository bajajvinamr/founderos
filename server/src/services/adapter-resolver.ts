/**
 * Adapter resolver.
 *
 * Translates (template agent preference + user-configured credentials +
 * optional strategy override) → concrete adapter_type + model for the
 * spawn service to write into the DB.
 *
 * This is what makes FounderOS multi-provider: every template declares
 * abstract "families" (anthropic / openai / google) and suggested models;
 * the resolver picks the first one the user has credentials for.
 */

import type {
  AgentAdapterType,
  AgentProviderPreference,
  FounderOSAdapterType,
  OnboardingAdapterChoice,
  ProviderFamily,
} from "@founderos/shared";

/**
 * A normalized view of what the instance operator has actually set up.
 * The InstanceCredentialStore populates this; the resolver consumes it.
 */
export type ProviderAvailability = {
  anthropic: { api: boolean; cli: boolean };
  openai: { api: boolean; cli: boolean };
  google: { api: boolean; cli: boolean };
  /** True when no keys at all are set. Callers may show an onboarding nag. */
  anyConfigured: boolean;
};

export type ProviderStrategy =
  /** Prefer Anthropic for every agent; fall back only if unavailable. */
  | "anthropic_first"
  | "openai_first"
  | "google_first"
  /** Respect each template's per-agent preference order (default). */
  | "mixed"
  /**
   * Force-use a single specific adapter + model for every agent (user override
   * in the spawn flow, e.g. "I want every agent on gpt-5-mini").
   */
  | { kind: "override"; adapterType: FounderOSAdapterType; model: string };

export type ResolvedAdapter = {
  adapterType: FounderOSAdapterType;
  model: string;
  /** Which provider family actually got picked (for UI surfacing). */
  family: ProviderFamily;
  /** Whether this run will bill the user's subscription (cli) or per-token (api). */
  execution: "cli" | "api";
};

export type ResolverError = {
  kind: "no_provider";
  wantedFamilies: ProviderFamily[];
  message: string;
};

/**
 * Resolve a single agent's adapter. Returns either the resolved config or
 * a structured error so the UI can render a helpful message ("set your
 * Anthropic key or install `claude` CLI first").
 */
export function resolveAgentAdapter(input: {
  preference: AgentProviderPreference | undefined;
  availability: ProviderAvailability;
  strategy: ProviderStrategy;
}): ResolvedAdapter | ResolverError {
  // Explicit user override wins over everything else.
  if (typeof input.strategy === "object" && input.strategy.kind === "override") {
    return {
      adapterType: input.strategy.adapterType,
      model: input.strategy.model,
      family: familyFromAdapter(input.strategy.adapterType),
      execution: executionFromAdapter(input.strategy.adapterType),
    };
  }

  const preference = input.preference ?? DEFAULT_PREFERENCE;
  const priority = reorderByStrategy(preference.families, input.strategy);

  for (const family of priority) {
    const avail = input.availability[family];
    if (!avail) continue;

    const suggestedModel =
      preference.suggestedModels[family] ?? DEFAULT_MODELS[family];
    if (!suggestedModel) continue;

    // Pick CLI vs API based on preferredExecution + what's available.
    const pick = pickExecution(avail, preference.preferredExecution);
    if (!pick) continue;

    // BYO-108: ADAPTER_MAP is now sparse — anthropic has no `api` slot since
    // no claude_api adapter exists. If the picked execution has no adapter
    // for this family, try the OTHER execution within the same family before
    // skipping to the next family. Better UX than "you have an Anthropic key
    // but I'll run OpenAI anyway."
    let adapter = ADAPTER_MAP[family]?.[pick];
    let execution: "cli" | "api" = pick;
    if (!adapter) {
      const fallback: "cli" | "api" = pick === "cli" ? "api" : "cli";
      const fallbackAvail = fallback === "cli" ? avail.cli : avail.api;
      const fallbackAdapter = fallbackAvail ? ADAPTER_MAP[family]?.[fallback] : undefined;
      if (fallbackAdapter) {
        adapter = fallbackAdapter;
        execution = fallback;
      }
    }
    if (!adapter) continue;

    return {
      adapterType: adapter,
      model: suggestedModel,
      family,
      execution,
    };
  }

  return {
    kind: "no_provider",
    wantedFamilies: priority,
    message: `No credentials configured for any of: ${priority.join(", ")}. Go to Instance Settings → AI Providers to add keys or install the CLIs.`,
  };
}

/**
 * Resolve a batch of agents with a shared strategy + availability snapshot.
 * Returns either all resolved or the first error encountered.
 */
export function resolveAgentAdaptersBatch(inputs: {
  agents: Array<{ key: string; preference: AgentProviderPreference | undefined }>;
  availability: ProviderAvailability;
  strategy: ProviderStrategy;
}):
  | { ok: true; resolved: Record<string, ResolvedAdapter> }
  | { ok: false; error: ResolverError; failingAgentKey: string } {
  const resolved: Record<string, ResolvedAdapter> = {};
  for (const agent of inputs.agents) {
    const result = resolveAgentAdapter({
      preference: agent.preference,
      availability: inputs.availability,
      strategy: inputs.strategy,
    });
    if ("kind" in result) {
      return { ok: false, error: result, failingAgentKey: agent.key };
    }
    resolved[agent.key] = result;
  }
  return { ok: true, resolved };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_PREFERENCE: AgentProviderPreference = {
  families: ["anthropic", "openai", "google"],
  suggestedModels: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-5-mini",
    google: "gemini-2.5-flash",
  },
  preferredExecution: "either",
};

const DEFAULT_MODELS: Record<ProviderFamily, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5-mini",
  google: "gemini-2.5-flash",
  other: "",
};

// BYO-108 — no `claude_api` adapter exists. Anthropic only has a `cli` slot;
// `pickExecution` will fall back to "cli" when "api" is requested but the
// `api` slot is undefined for the family. Same for `gemini` — `gemini_local`
// handles both modes internally.
const ADAPTER_MAP: Record<
  "anthropic" | "openai" | "google",
  Partial<Record<"cli" | "api", FounderOSAdapterType>>
> = {
  anthropic: { cli: "claude_local" },
  openai: { cli: "codex_local", api: "openai_api" },
  google: { cli: "gemini_local" },
};

type SupportedFamily = "anthropic" | "openai" | "google";

function reorderByStrategy(
  templateOrder: ProviderFamily[],
  strategy: ProviderStrategy,
): SupportedFamily[] {
  const supported = templateOrder.filter(isSupportedFamily);
  if (strategy === "mixed" || typeof strategy === "object") return supported;

  const firstFamily: SupportedFamily =
    strategy === "anthropic_first" ? "anthropic"
    : strategy === "openai_first" ? "openai"
    : "google";

  const rest = supported.filter((f) => f !== firstFamily);
  return [firstFamily, ...rest];
}

function isSupportedFamily(f: ProviderFamily): f is SupportedFamily {
  return f === "anthropic" || f === "openai" || f === "google";
}

function pickExecution(
  avail: { api: boolean; cli: boolean },
  preferred: "cli" | "api" | "either",
): "cli" | "api" | null {
  if (preferred === "cli") {
    if (avail.cli) return "cli";
    if (avail.api) return "api";
    return null;
  }
  if (preferred === "api") {
    if (avail.api) return "api";
    if (avail.cli) return "cli";
    return null;
  }
  // "either"
  if (avail.cli) return "cli";
  if (avail.api) return "api";
  return null;
}

function familyFromAdapter(adapter: FounderOSAdapterType): ProviderFamily {
  switch (adapter) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
    case "openai_api":
      return "openai";
    case "gemini_local":
      return "google";
    default:
      return "other";
  }
}

function executionFromAdapter(adapter: FounderOSAdapterType): "cli" | "api" {
  return adapter.endsWith("_api") ? "api" : "cli";
}

// ──────────────────────────────────────────────────────────────────────────
// S7.0.2 — Onboarding choice → adapter type mapping
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the founder's onboarding adapter pick into the concrete
 * `agents.adapter_type` value to write into the DB.
 *
 * This is the simple, deterministic counterpart to `resolveAgentAdapter`:
 * the founder explicitly picked a CLI in the wizard, and this function
 * just translates the wire-format choice into the row value. It does NOT
 * consult availability — that's the runner's job at dispatch time
 * (and the missing-CLI experience surfaces there as a clean error
 * rather than a silent no-op).
 *
 * Used by `onboarding-bootstrap.ts` (S7.2) to reverse the historical
 * "all choices collapse to byo_runner" behavior.
 *
 * Notes:
 *   - `anthropic_api` maps 1:1 to the registered `anthropic_api`
 *     adapter as of 2026-05-18 (G3b). The historical collapse to
 *     `claude_local` is removed — there is now a real Anthropic API
 *     adapter at `packages/adapters/anthropic-api/` that calls
 *     `@anthropic-ai/sdk` directly. The founder's key is resolved at
 *     run time via `instanceApiKeysService.getDecrypted("anthropic",
 *     "api")` injected by the heartbeat dispatch layer.
 *   - `openai_api` maps 1:1 to the registered `openai_api` adapter
 *     (added to AGENT_ADAPTER_TYPES alongside the S7 sprint).
 *   - `google_api` is part of the 6-tile MVP onboarding surface but
 *     has no agent runtime handler yet — Phase 4 of S7 ships the
 *     Google API adapter. For now this throws a clear "not yet
 *     implemented" error so the bootstrap call site (S7.2) surfaces
 *     it rather than silently writing a row that the dispatcher
 *     can't execute.
 *   - `skip` defaults to `claude_local` to preserve pre-S7 behavior
 *     for founders who defer the decision; they can change it later
 *     in Settings → Providers.
 *   - `cursor_local` aligns with the rest of the `*_local` family
 *     post-S7.0.4 rename (was `"cursor"` pre-2026-05-07). Cursor is
 *     OUT of MVP wizard surface but the schema retains it for
 *     legacy compatibility.
 */
export function mapOnboardingChoiceToAdapter(
  choice: OnboardingAdapterChoice,
): AgentAdapterType {
  switch (choice) {
    case "claude_local":
    case "skip":
      return "claude_local";
    case "anthropic_api":
      return "anthropic_api";
    case "codex_local":
      return "codex_local";
    case "openai_api":
      return "openai_api";
    case "gemini_local":
      return "gemini_local";
    case "google_api":
      // S7.0.2 — Renamed to gemini_api in Phase C3. The UI choice remains
      // "google_api" for backwards compatibility with any in-flight onboarding
      // payloads, but the adapter type resolves to gemini_api.
      return "gemini_api";
    case "opencode_local":
      return "opencode_local";
    case "pi_local":
      return "pi_local";
    case "cursor_local":
      return "cursor_local";
    case "hermes_local":
      return "hermes_local";
  }
}
