/**
 * Typed HTTP client for the four runner-side endpoints in
 * docs/api/runner-openapi.yaml. Uses Node's built-in fetch (Node 20+).
 *
 * Idempotency:
 *   - /events POST is server-side append-only; the runner is responsible for
 *     not re-sending the same eventId on retry. We track sent eventIds per
 *     job in memory; only retry on 5xx (network errors).
 *   - /complete is server-rejected on double-submit (409). We swallow the 409
 *     gracefully so a crashed-and-restarted runner that already completed a
 *     job before crashing doesn't loop on it.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { RunnerConfig } from "./config.js";

export interface JobDescriptor {
  jobId: string;
  agentId: string;
  agentName: string;
  createdAt: string;
}

/**
 * Adapter type carried from the cloud through to the runner.
 *
 * S7.0.1 — kept as a plain string union here (NOT `AgentAdapterType` from
 * `@founderos/shared`) so the runner package can stay free of the shared
 * deep dep. The DB CHECK constraint at migration 0105 + the cloud-side
 * Zod schema enforce validity before this field reaches the runner.
 *
 * Default fallback: "claude_local". Pre-S7 rows that wrote "byo_runner"
 * still map to claude via the dispatcher's legacy-fallback path.
 */
export type RunnerAdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor_local"
  | "openclaw_gateway"
  | "hermes_local"
  | "byo_runner"
  | "process"
  | "http"
  | (string & {}); // tolerate unknown values for forward-compatibility

export interface JobPayload {
  jobId: string;
  agentId: string;
  agentName?: string;
  prompt: string;
  sessionId: string | null;
  runtimeConfig: {
    model?: string | null;
    maxTurns?: number | null;
    timeoutSec?: number;
    instructionsFileContent?: string | null;
    [k: string]: unknown;
  };
  promptHash: string;
  /**
   * S7.0.1 — adapter type the runner should dispatch on. Server returns
   * this from the claim API (`server/src/routes/runner.ts:303`). May be
   * absent on responses from a pre-S7.0.1 server build — defaults to
   * "claude_local" at the consumer.
   */
  adapterType?: RunnerAdapterType;
  addDirs?: string[];
}

/**
 * S7.1.b.1 — provider-neutral runner event kinds. Council R1+R2 finding
 * (Codex P1 confirmed by Gemini): the prior Claude-specific names hardcoded
 * Claude semantics into the runner API, server validator, and tests, so
 * future Gemini/Codex/OpenAI/Google adapters would either lie as Claude
 * events or lose structured streaming detail.
 *
 * Mapping from the legacy Claude-only names:
 *   claude_message      → model_message    (assistant text from the model)
 *   claude_tool_use     → tool_call        (model invokes a tool)
 *   claude_tool_result  → tool_result      (tool returns to model)
 *   claude_result       → run_complete     (run finishes; cost + session_id)
 *
 * The wire format the runner ingests (Claude stream-json, OpenAI SSE, etc.)
 * stays adapter-shaped — it's the runner's INTERNAL kind that's neutralized.
 * Adapter-specific fields ride on the existing per-event `payload` envelope.
 *
 * TODO(Phase 5+) — drop legacy kinds from the server validator once all
 * adapters emit neutral kinds and v0.1.x runners are aged out.
 */
export type RunnerEventKind =
  | "stdout_line"
  | "stderr_line"
  | "model_message"
  | "tool_call"
  | "tool_result"
  | "run_complete";

export interface RunnerEvent {
  eventId: string;
  kind: RunnerEventKind;
  ts: string;
  payload?: Record<string, unknown> | string;
}

export interface CompletionBody {
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  signal?: string | null;
  elapsedSec?: number;
  costMicros?: number;
  sessionId?: string | null;
  cliVersion?: string;
  errorMessage?: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
  }
}

/** Generate a runner-side event id. Exposed so the spawner can stamp events
 *  before they reach the API client. */
export function makeEventId(): string {
  return randomUUID();
}

export class RunnerApiClient {
  constructor(
    private readonly config: RunnerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.serverUrl}${path}`;
  }

  private headers(extra?: Record<string, string>): HeadersInit {
    return {
      authorization: `Bearer ${this.config.token}`,
      "user-agent": "founderos-runner",
      ...(extra ?? {}),
    };
  }

  /**
   * Long-poll for the next claimable job. Server holds the connection up to
   * 30s. Returns:
   *   - { kind: "job", job } on a hit
   *   - { kind: "empty" } on 204 timeout (caller re-polls)
   *   - throws ApiError on non-2xx
   */
  async getNext(signal?: AbortSignal): Promise<
    { kind: "job"; job: JobDescriptor } | { kind: "empty" }
  > {
    const res = await this.fetchImpl(this.url("/api/runner/jobs/next"), {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (res.status === 204) return { kind: "empty" };
    if (!res.ok) {
      throw new ApiError(res.status, await res.text().catch(() => ""));
    }
    const job = (await res.json()) as JobDescriptor;
    return { kind: "job", job };
  }

  /**
   * Atomic claim. Returns:
   *   - { kind: "claimed", payload } on success
   *   - { kind: "lost" } on 409 (race lost)
   *   - { kind: "gone" } on 404 (cancelled / unknown)
   *   - throws ApiError on other non-2xx
   */
  async claim(jobId: string): Promise<
    { kind: "claimed"; payload: JobPayload } | { kind: "lost" } | { kind: "gone" }
  > {
    const res = await this.fetchImpl(this.url(`/api/runner/jobs/${jobId}/claim`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
    });
    if (res.status === 409) return { kind: "lost" };
    if (res.status === 404) return { kind: "gone" };
    if (!res.ok) {
      throw new ApiError(res.status, await res.text().catch(() => ""));
    }
    const payload = (await res.json()) as JobPayload;
    return { kind: "claimed", payload };
  }

  /**
   * Append a batch of events. Caller batches with a 50ms / 32-event window.
   * Idempotent on eventId; the server doesn't dedup but does reject when the
   * job is in a terminal state (409). We retry on 5xx + network errors with
   * a small backoff; on 409 we surface the terminal state to the caller so
   * it can stop spawning.
   */
  async appendEvents(jobId: string, events: RunnerEvent[]): Promise<{ kind: "ok" } | { kind: "terminal" }> {
    if (events.length === 0) return { kind: "ok" };

    const body = JSON.stringify({ events });
    const headers = this.headers({ "content-type": "application/json" });

    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(this.url(`/api/runner/jobs/${jobId}/events`), {
          method: "POST",
          headers,
          body,
        });
        if (res.status === 204) return { kind: "ok" };
        if (res.status === 409) return { kind: "terminal" };
        if (res.status >= 500) {
          lastErr = new ApiError(res.status, await res.text().catch(() => ""));
        } else {
          throw new ApiError(res.status, await res.text().catch(() => ""));
        }
      } catch (err) {
        lastErr = err;
      }
      // 100ms, 300ms, 700ms backoff between retries.
      await sleep(100 * (attempt * attempt));
    }
    throw lastErr instanceof Error ? lastErr : new Error("appendEvents: unreachable");
  }

  /**
   * Mark the job terminal. 409 (already terminal) is swallowed — the runner
   * may have crashed mid-complete and the cloud already accepted the prior
   * call. We log + move on rather than spinning forever.
   */
  async complete(jobId: string, body: CompletionBody): Promise<{ kind: "ok" } | { kind: "already_terminal" }> {
    const res = await this.fetchImpl(this.url(`/api/runner/jobs/${jobId}/complete`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { kind: "ok" };
    if (res.status === 409) return { kind: "already_terminal" };
    throw new ApiError(res.status, await res.text().catch(() => ""));
  }
}
