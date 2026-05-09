/**
 * Adapter registry — keyed on `RunnerAdapterType`. The dispatcher
 * (S7.1.b.3) reads from this registry to route a claimed job to the
 * matching handler. Handlers themselves are simple values that satisfy
 * either {@link SubprocessAdapter} or {@link ApiAdapter}; see
 * `../handlers/types.ts` for the contract.
 *
 * `Partial<Record<...>>` (not bare `Record<...>`) is intentional:
 * S7.1.b.2 only ships `claude_local`. The rest of the families
 * (`gemini_local`, `codex_local`, `cursor_local`, `openai_api`,
 * `anthropic_api`, `google_api`, ...) land in S7.1.c / S7.B.* / S7.C.
 * The `satisfies` clause still gives compile-time exhaustiveness on
 * what IS implemented — adding a key whose value type doesn't match
 * `AnyAdapter` (e.g. forgetting the `transport: "subprocess"` discriminant)
 * fails to compile here, which is exactly the safety we want.
 *
 * Council both-confirmed P3 (2026-05-09): registry MUST give compile-time
 * exhaustiveness via `satisfies`. Not a `Map` (no compile-time key check),
 * not a bare object literal (no `AnyAdapter` constraint).
 */

import type { RunnerAdapterType } from "../api.js";
import type { AnyAdapter } from "../handlers/types.js";

import { claudeLocalAdapter } from "./claude.js";
import { codexLocalAdapter } from "./codex.js";
import { geminiLocalAdapter } from "./gemini.js";

/**
 * The runner's adapter registry. Phase-4 adapters land here as they
 * implement the {@link AnyAdapter} contract:
 *   - S7.1.b.2 — `claude_local` (structural template; lifecycle in
 *                S7.1.c.1).
 *   - S7.B.gemini — `gemini_local` (mirrors claude_local; encodes the
 *                   `GEMINI_CLI_TRUST_WORKSPACE` (Invariant 1) and
 *                   `MODEL_CAPACITY_EXHAUSTED` (Invariant 2) gotchas
 *                   from `~/.claude/rules/vinamr-invariants.md`).
 *   - S7.B.codex — `codex_local` (mirrors gemini_local; encodes the
 *                  Codex Multi-CLI optional-param invariant from
 *                  `~/.claude/rules/vinamr-invariants.md` — the default
 *                  argv MUST NOT include `--approval-policy` / `--sandbox`
 *                  or the CLI exits 2 with "unexpected argument '-a'").
 *   - S7.C / future — cursor_local, openai_api, anthropic_api, google_api.
 *
 * Note: `gemini_local` and `codex_local` are dormant under V1
 * (`FOUNDEROS_DISPATCHER_V2=0` — explicit opt-out; default V2 is ON
 * since task #50).
 *
 * Use `getAdapter(type)` for runtime lookups so the registry doesn't
 * leak to call sites that only need a single handler.
 */
export const ADAPTER_HANDLERS = {
  claude_local: claudeLocalAdapter,
  codex_local: codexLocalAdapter,
  gemini_local: geminiLocalAdapter,
} as const satisfies Partial<Record<RunnerAdapterType, AnyAdapter>>;

export type ImplementedAdapterType = keyof typeof ADAPTER_HANDLERS;

/**
 * Look up the adapter handler for an adapter type. Returns `undefined`
 * for un-implemented types — the dispatcher decides whether to fall
 * back to the legacy `claude_local` path or fail the job loudly.
 *
 * Cast through `string` because `RunnerAdapterType` includes the
 * forward-compat `(string & {})` escape hatch — runtime values may not
 * be in the registry even when they typecheck.
 */
export function getAdapter(type: RunnerAdapterType): AnyAdapter | undefined {
  return (ADAPTER_HANDLERS as Readonly<Record<string, AnyAdapter>>)[type];
}
