/**
 * Adapter dispatcher — S7.1.b.3.
 *
 * Wires {@link ADAPTER_HANDLERS} to a single {@link runAdapter} entry point
 * the runner's main loop will call instead of the legacy `runClaude` path.
 * The keystone {@link AdapterHandler} interface from S7.1.b.2 (PR #107) is
 * the contract; this file is the consumer that turns "adapterType claimed
 * from cloud" + per-job context into a stream of provider-neutral events
 * plus a terminal {@link RunResult}.
 *
 * ## Return-shape choice: `AsyncGenerator<RunnerEvent, RunResult, void>`
 *
 * The function is itself an async generator that re-yields the handler's
 * events and **returns** the handler's terminal {@link RunResult}. This
 * preserves streaming semantics end-to-end — the caller can `iter.next()`
 * one event at a time and forward to the cloud event-batcher without buffering
 * the whole run in memory. The eager-collected `Promise<{events, result}>`
 * shape was rejected because it would materialize unbounded events for
 * long-running jobs and lose the cloud's incremental-streaming contract
 * (`/runner/jobs/:id/events` accepts partial batches).
 *
 * ## CRITICAL invariant — capture the AsyncGenerator's return value
 *
 * `for await (const evt of handler.run(ctx, signal)) { ... }` silently
 * DROPS the generator's return value. {@link AdapterHandler.run} is typed
 * as `AsyncGenerator<RunnerEvent, RunResult, void>`; the `RunResult`
 * (cost / sessionId / exitCode / httpStatus) lives in the second type
 * parameter, which `for await` discards. The dispatcher MUST drive the
 * iterator manually via `iter.next()` and read `step.value` once
 * `step.done === true`. Forward-threaded from the S7.1.b.2 council pass
 * (Codex P2 + Gemini P2 confirmed); see `~/.claude/rules/vinamr-invariants.md`
 * §"Vanta" for the analogous return-value-loss class of bug.
 */

import { ADAPTER_HANDLERS } from "./adapters/index.js";
import type { RunnerEvent, RunnerAdapterType } from "./api.js";
import type { AnyAdapter, RunContext, RunResult } from "./handlers/types.js";

/**
 * Error thrown when {@link runAdapter} is asked for an adapter type that
 * has no entry in {@link ADAPTER_HANDLERS}. Distinct error class so the
 * runner's main loop can choose to fail the job loudly with `errorCode:
 * "unknown"` rather than fall through to the legacy `claude_local` path.
 *
 * `RunnerAdapterType` includes the forward-compat `(string & {})` escape
 * hatch — runtime values may not be in the registry even when they
 * typecheck, so this is a normal runtime error, not a defensive impossibility.
 */
export class UnknownAdapterTypeError extends Error {
  constructor(public readonly adapterType: string) {
    super(`No handler registered for adapter type: ${adapterType}`);
    this.name = "UnknownAdapterTypeError";
  }
}

/**
 * Look up the adapter for `adapterType` and stream its events while
 * capturing the terminal {@link RunResult}. The returned AsyncGenerator's
 * **own return value** is the captured `RunResult` — callers MUST drive
 * the iterator with `iter.next()` (or `await runner.return(undefined)` on
 * cancel) to read it. A bare `for await` loop will lose the result silently.
 *
 * Cancellation: `signal` is forwarded directly to the handler's
 * {@link AdapterHandler.run}. Subprocess adapters kill the child on abort;
 * API adapters abort the underlying fetch. The dispatcher does not wrap
 * the abort with timeout escalation here — that lives in the runner's
 * main loop (S7.1.c) where the timeout policy from `RunContext.timeoutSec`
 * gets enforced.
 *
 * Throws {@link UnknownAdapterTypeError} synchronously (before yielding
 * any event) when `adapterType` is not in the registry. Any error thrown
 * BY the handler propagates unchanged — the main loop is the one that
 * routes errors through `interpretFailure`.
 */
export async function* runAdapter(
  adapterType: RunnerAdapterType,
  ctx: RunContext,
  signal: AbortSignal,
): AsyncGenerator<RunnerEvent, RunResult, void> {
  const handler = lookupHandler(adapterType);
  const iter = handler.run(ctx, signal);
  while (true) {
    const step = await iter.next();
    if (step.done) {
      // step.value is RunResult per the AsyncGenerator type parameters.
      return step.value;
    }
    yield step.value;
  }
}

/**
 * Resolve an adapter type to its handler, throwing
 * {@link UnknownAdapterTypeError} when absent. Exported for unit tests +
 * future call sites that need to look up an adapter without invoking it
 * (e.g. environment-checks pre-flight before the run starts).
 */
export function lookupHandler(adapterType: RunnerAdapterType): AnyAdapter {
  const registry = ADAPTER_HANDLERS as Readonly<Record<string, AnyAdapter | undefined>>;
  const handler = registry[adapterType];
  if (!handler) {
    throw new UnknownAdapterTypeError(adapterType);
  }
  return handler;
}
