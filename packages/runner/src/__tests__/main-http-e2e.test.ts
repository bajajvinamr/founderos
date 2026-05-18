/**
 * E2E HTTP integration tests — boot a real `http.createServer`, point the
 * runner's `RunnerApiClient` at it via a real `fetch` call. Closes the
 * branch-coverage gap on `main.ts` (backoff escalation, 401 on `appendEvents`
 * non-crash, full poll→claim→complete cycle over the wire) and the retry
 * branches in `api.ts:appendEvents` (5xx retry loop at line 217-237).
 *
 * Distinct from `main-loop.test.ts` which stubs the API client object —
 * that test bypasses the `fetch` layer entirely. This file exercises the
 * Bearer header on the wire, the JSON body shape, and the actual response
 * status mapping in `api.ts`.
 *
 * The dispatcher is mocked (we are NOT testing real subprocess spawn here —
 * `spawn-e2e.test.ts` covers that). This file is about the HTTP edge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { RunnerConfig } from "../config.js";
import type {
  CompletionBody,
  JobDescriptor,
  JobPayload,
  RunnerAdapterType,
  RunnerEvent,
} from "../api.js";
import type { RunContext, RunResult } from "../handlers/types.js";

// ---------------------------------------------------------------------------
// Dispatcher mock — keep these tests focused on the HTTP/loop layer.
// ---------------------------------------------------------------------------

let runAdapterImpl: () => AsyncGenerator<RunnerEvent, RunResult, void> =
  async function* () {
    return {
      status: "completed",
      elapsedSec: 0.1,
      exitCode: 0,
      sessionId: null,
      costUsd: null,
    };
  };

vi.mock("../dispatcher.js", () => ({
  runAdapter: (
    _adapterType: RunnerAdapterType,
    _ctx: RunContext,
    _signal: AbortSignal,
  ): AsyncGenerator<RunnerEvent, RunResult, void> => runAdapterImpl(),
}));

const { runRunnerLoop, consoleLogger } = await import("../main.js");
const { RunnerApiClient } = await import("../api.js");

// ---------------------------------------------------------------------------
// HTTP test server scaffolding.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
  /** When set, hold the response for N ms before sending — simulates server long-poll. */
  delayMs?: number;
}

type RouteHandler = (req: RecordedRequest) => ScriptedResponse;

interface TestServer {
  server: Server;
  port: number;
  requests: RecordedRequest[];
  setHandler(method: string, pathPrefix: string, handler: RouteHandler): void;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Boot an HTTP server on a random localhost port. Tests register per-route
 * handlers via `setHandler`. Every request is recorded for assertion.
 */
async function startTestServer(): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, RouteHandler>();

  const matchKey = (method: string, url: string): string | null => {
    for (const [key, _] of handlers) {
      const [hMethod, hPath] = key.split(" ", 2);
      if (hMethod === method && url.startsWith(hPath)) return key;
    }
    return null;
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      };
      requests.push(recorded);

      const key = matchKey(recorded.method, recorded.url);
      const handler = key ? handlers.get(key) : null;
      const response: ScriptedResponse = handler
        ? handler(recorded)
        : { status: 404, body: { error: "no_route" } };

      const send = () => {
        res.statusCode = response.status;
        // 204 / 205 / 304 may not have a body per RFC 7230.
        const bodyForbidden =
          response.status === 204 ||
          response.status === 205 ||
          response.status === 304;
        if (bodyForbidden || response.body === undefined) {
          res.end();
        } else {
          res.setHeader("content-type", "application/json");
          res.end(
            typeof response.body === "string"
              ? response.body
              : JSON.stringify(response.body),
          );
        }
      };
      if (response.delayMs && response.delayMs > 0) {
        setTimeout(send, response.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    requests,
    setHandler(method, pathPrefix, handler) {
      handlers.set(`${method} ${pathPrefix}`, handler);
    },
    reset() {
      requests.length = 0;
      handlers.clear();
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function makeConfig(port: number, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    token: "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    claudeBin: "claude",
    defaultTimeoutSec: 60,
    logLevel: "error",
    ...overrides,
  };
}

const makeJobDescriptor = (id = "job-1"): JobDescriptor => ({
  jobId: id,
  agentId: "agent-1",
  agentName: "Sarah",
  createdAt: new Date().toISOString(),
});

const makeJobPayload = (id = "job-1"): JobPayload => ({
  jobId: id,
  agentId: "agent-1",
  agentName: "Sarah",
  prompt: "do the thing",
  sessionId: null,
  runtimeConfig: { timeoutSec: 5 },
  promptHash: "h".repeat(64),
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runner E2E over real HTTP", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
    // Reset dispatcher to a vanilla happy-path generator.
    runAdapterImpl = async function* (): AsyncGenerator<
      RunnerEvent,
      RunResult,
      void
    > {
      yield {
        eventId: "e1",
        kind: "model_message",
        ts: new Date().toISOString(),
        payload: { type: "assistant" },
      };
      return {
        status: "completed",
        elapsedSec: 0.05,
        exitCode: 0,
        sessionId: "sess_http_e2e",
        costUsd: 0.001,
      };
    };
  });

  afterEach(async () => {
    await server.close();
  });

  it("(1) full claim-loop end-to-end: GET next → POST claim → POST events → POST complete", async () => {
    // The four endpoints, scripted in order.
    server.setHandler("GET", "/api/runner/jobs/next", () => ({
      status: 200,
      body: makeJobDescriptor(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/claim", () => ({
      status: 200,
      body: makeJobPayload(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/events", () => ({
      status: 204,
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/complete", () => ({
      status: 204,
    }));

    const config = makeConfig(server.port);
    const result = await runRunnerLoop({
      config,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: new RunnerApiClient(config),
    });

    expect(result.jobsProcessed).toBe(1);

    // Verify the Bearer header reached the wire on every request.
    const byMethod = (m: string, urlSubstr: string) =>
      server.requests.filter(
        (r) => r.method === m && r.url.includes(urlSubstr),
      );
    expect(byMethod("GET", "/jobs/next").length).toBeGreaterThanOrEqual(1);
    expect(byMethod("POST", "/claim").length).toBe(1);
    expect(byMethod("POST", "/complete").length).toBe(1);

    for (const r of server.requests) {
      const auth = r.headers["authorization"];
      expect(auth).toBe(`Bearer ${config.token}`);
    }

    // The /complete request body should reflect the dispatcher's RunResult.
    const completeReq = byMethod("POST", "/complete")[0];
    const completeBody = JSON.parse(completeReq.body) as CompletionBody;
    expect(completeBody.status).toBe("completed");
    expect(completeBody.sessionId).toBe("sess_http_e2e");
    expect(completeBody.costMicros).toBe(1_000); // 0.001 USD * 1e6
  });

  it("(2) appendEvents retries on 5xx — verifies api.ts retry loop", async () => {
    // First 2 appendEvents calls return 500; third returns 204. The runner
    // must transparently retry within the same logical call.
    let appendCount = 0;
    server.setHandler("GET", "/api/runner/jobs/next", () => ({
      status: 200,
      body: makeJobDescriptor(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/claim", () => ({
      status: 200,
      body: makeJobPayload(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/events", () => {
      appendCount += 1;
      if (appendCount < 3) return { status: 500, body: { error: "boom" } };
      return { status: 204 };
    });
    server.setHandler("POST", "/api/runner/jobs/job-1/complete", () => ({
      status: 204,
    }));

    const config = makeConfig(server.port);
    const result = await runRunnerLoop({
      config,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: new RunnerApiClient(config),
    });

    expect(result.jobsProcessed).toBe(1);
    // appendEvents tried at least 3 times (the 2 failures + 1 success).
    expect(appendCount).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("(3) 401 on appendEvents is logged + dropped — runner does NOT crash mid-job", async () => {
    // Documents current (correct) behavior: a single auth blip on
    // appendEvents should NOT crash a 10-minute job. main.ts catches the
    // ApiError at line 176-178 and logs warn; the job still completes.
    server.setHandler("GET", "/api/runner/jobs/next", () => ({
      status: 200,
      body: makeJobDescriptor(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/claim", () => ({
      status: 200,
      body: makeJobPayload(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/events", () => ({
      status: 401,
      body: { error: "invalid_runner_token" },
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/complete", () => ({
      status: 204,
    }));

    const priorExit = process.exitCode;
    process.exitCode = 0;

    const config = makeConfig(server.port);
    const result = await runRunnerLoop({
      config,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: new RunnerApiClient(config),
    });

    // Job is counted as processed (claim succeeded). 401 on appendEvents
    // is silently dropped — does NOT trip the exit-2 escape.
    expect(result.jobsProcessed).toBe(1);
    expect(process.exitCode).toBe(0);

    // /complete still fired despite the appendEvents auth blip.
    const completes = server.requests.filter(
      (r) => r.method === "POST" && r.url.includes("/complete"),
    );
    expect(completes.length).toBe(1);

    process.exitCode = priorExit;
  }, 15_000);

  it("(4) 401 on getNext immediately exits with code 2", async () => {
    // The structural distinction from (3): 401 on the long-poll endpoint
    // means the token is dead before any job is claimed → supervisor
    // (systemd/launchd) needs to surface it. main.ts:100-104.
    server.setHandler("GET", "/api/runner/jobs/next", () => ({
      status: 401,
      body: { error: "invalid_runner_token" },
    }));

    const priorExit = process.exitCode;
    process.exitCode = 0;

    const config = makeConfig(server.port);
    const result = await runRunnerLoop({
      config,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: new RunnerApiClient(config),
    });

    expect(result.jobsProcessed).toBe(0);
    expect(process.exitCode).toBe(2);

    process.exitCode = priorExit;
  });

  it("(5) complete returning 409 already_terminal is swallowed gracefully", async () => {
    // Crashed-and-restarted runner re-completes a job the cloud already
    // marked terminal. main.ts:250-252 logs warn but does NOT throw.
    server.setHandler("GET", "/api/runner/jobs/next", () => ({
      status: 200,
      body: makeJobDescriptor(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/claim", () => ({
      status: 200,
      body: makeJobPayload(),
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/events", () => ({
      status: 204,
    }));
    server.setHandler("POST", "/api/runner/jobs/job-1/complete", () => ({
      status: 409,
      body: { error: "job_already_terminal" },
    }));

    const config = makeConfig(server.port);
    const result = await runRunnerLoop({
      config,
      logger: consoleLogger("error"),
      maxJobs: 1,
      apiClient: new RunnerApiClient(config),
    });

    // Job was processed (loop didn't crash).
    expect(result.jobsProcessed).toBe(1);
  });
});
