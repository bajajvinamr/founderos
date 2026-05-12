/**
 * Adapter types shipped with FounderOS. External plugins must not replace these.
 *
 * Note: `byo_runner` (ADR-011) is in this set so that adapter-type validation
 * accepts agents configured with it, but its REGISTRATION is conditional on
 * FOUNDEROS_BYO_RUNNER_ENABLED. See server/src/adapters/byo-runner/index.ts
 * and the wire-up call in app.ts.
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor_local",
  "gemini_local",
  // openai_api: direct OpenAI API path. Mirror of the addition in
  // packages/shared/src/constants.ts AGENT_ADAPTER_TYPES per PHASE-S7 TRD §3.
  "openai_api",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "hermes_local",
  "byo_runner",
  "process",
  "http",
]);
