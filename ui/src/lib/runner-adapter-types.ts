/**
 * Display registry + gating helpers for hosted-runner adapter types.
 *
 * Hosted runners are adapters whose execution lives in the founder's
 * `@founderos/runner` daemon (BYO runner) rather than in a server-spawned
 * process or HTTP gateway. The set determines whether the company-level
 * `RunnerStatusPill` is surfaced on the Team page — without at least one
 * hosted-runner agent, runner liveness is irrelevant to the founder.
 *
 * Two adapter types are explicitly OUT of this set: `process` and `http`.
 * They are server-side adapters; their liveness is not surfaced by the pill.
 *
 * Forward-compat: `openai_api` is being added to `AGENT_ADAPTER_TYPES` in
 * S7.A.1 (in flight). The UI registry intentionally lists it here ahead of
 * the shared constants — display metadata is allowed to know about types the
 * type system hasn't formalized yet.
 *
 * @see PHASE-S7-multi-provider.md S7.B.7
 */

/**
 * Adapter types whose liveness is surfaced by the company-level
 * `RunnerStatusPill`. Server-side adapters (`process`, `http`) are
 * intentionally excluded.
 */
export const BYO_RUNNER_HOSTED_ADAPTERS: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  // S7.A.1 will add this to AGENT_ADAPTER_TYPES; UI registry knows about it
  // now for forward-compat.
  "openai_api",
]);

/** Display metadata for a hosted-runner adapter shown in UI badges. */
export interface AdapterDisplayInfo {
  /** Long form label, e.g. "Claude Code". */
  label: string;
  /** Short label suited to tight badges, e.g. "Claude". */
  shortLabel: string;
  /** Provider family for color/grouping. */
  family: "anthropic" | "openai" | "google" | "other";
  /** shadcn `Badge` variant to pair with the family. */
  badgeColor: "default" | "secondary" | "outline";
}

/**
 * Display metadata keyed by adapter_type. Only hosted-runner adapter types
 * appear here; `process`/`http`/unknown types resolve to `null` via
 * `getAdapterDisplay`.
 */
export const RUNNER_ADAPTER_DISPLAY: Readonly<Record<string, AdapterDisplayInfo>> = {
  claude_local: {
    label: "Claude Code",
    shortLabel: "Claude",
    family: "anthropic",
    badgeColor: "default",
  },
  codex_local: {
    label: "Codex CLI",
    shortLabel: "Codex",
    family: "openai",
    badgeColor: "secondary",
  },
  gemini_local: {
    label: "Gemini CLI",
    shortLabel: "Gemini",
    family: "google",
    badgeColor: "secondary",
  },
  opencode_local: {
    label: "OpenCode",
    shortLabel: "OpenCode",
    family: "other",
    badgeColor: "outline",
  },
  // S7.A.1 will add this to AGENT_ADAPTER_TYPES; UI registry knows about it
  // now for forward-compat.
  openai_api: {
    label: "OpenAI API",
    shortLabel: "OpenAI",
    family: "openai",
    badgeColor: "secondary",
  },
};

/**
 * Resolve display metadata for a given adapter type. Returns `null` for
 * server-side (`process`, `http`), unknown, or undefined types — callers
 * should hide the badge in that case.
 */
export function getAdapterDisplay(
  adapterType: string | null | undefined,
): AdapterDisplayInfo | null {
  if (!adapterType) return null;
  return RUNNER_ADAPTER_DISPLAY[adapterType] ?? null;
}

/** True if the adapter type is a hosted-runner adapter. */
export function isHostedRunnerAdapter(
  adapterType: string | null | undefined,
): boolean {
  if (!adapterType) return false;
  return BYO_RUNNER_HOSTED_ADAPTERS.has(adapterType);
}

/**
 * S8 P0.1 Phase 2B — true when the agent's `claude_local` adapter is
 * actually executing on the server (via the in-process Anthropic SDK
 * handler) rather than on a laptop runner. Gated by the build-time
 * `VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED` flag, which mirrors the
 * server-side `FOUNDEROS_HOSTED_AGENTS_ENABLED`. When true, the agent
 * has no laptop-runner footprint — UI affordances should suppress the
 * "Connect runner" CTA in favor of a "Hosted on FounderOS" badge.
 *
 * Exported as a function (not a precomputed boolean) so tests can mutate
 * `import.meta.env` between cases without module re-import shenanigans.
 */
export function isHostedClaudeLocalAgent(
  adapterType: string | null | undefined,
): boolean {
  if (adapterType !== "claude_local") return false;
  // Vite injects env vars as strings; "1" is the canonical truthy value.
  return import.meta.env.VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED === "1";
}

/**
 * True if any agent in `agents` runs on a hosted-runner adapter. Drives the
 * gating decision for whether to render `RunnerStatusPill` on the Team page.
 */
export function hasHostedRunnerAdapter(
  agents: ReadonlyArray<{ adapterType?: string | null }> | null | undefined,
): boolean {
  if (!agents) return false;
  return agents.some((a) => isHostedRunnerAdapter(a.adapterType ?? null));
}
