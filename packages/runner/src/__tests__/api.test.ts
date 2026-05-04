/**
 * RunnerApiClient contract tests — fake fetch implementation, no network.
 * Verifies the wire format we send matches docs/api/runner-openapi.yaml.
 */

import { describe, it, expect } from "vitest";
import { RunnerApiClient, ApiError } from "../api.js";
import type { RunnerConfig } from "../config.js";

const baseConfig: RunnerConfig = {
  serverUrl: "https://founderos.fly.dev",
  token: "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  claudeBin: "claude",
  defaultTimeoutSec: 600,
  logLevel: "info",
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(response: { status: number; body?: unknown }): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    // Response constructor refuses bodies on 204/205/304 — pass null for those.
    const isBodyForbidden =
      response.status === 204 || response.status === 205 || response.status === 304;
    const body = isBodyForbidden
      ? null
      : response.body === undefined
        ? ""
        : typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
    return new Response(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("RunnerApiClient.getNext", () => {
  it("returns 'job' on 200 with descriptor", async () => {
    const job = {
      jobId: "job-1",
      agentId: "agent-1",
      agentName: "Sarah",
      createdAt: new Date().toISOString(),
    };
    const { fn, calls } = makeFakeFetch({ status: 200, body: job });
    const client = new RunnerApiClient(baseConfig, fn);

    const res = await client.getNext();
    expect(res).toEqual({ kind: "job", job });
    expect(calls[0].url).toBe("https://founderos.fly.dev/api/runner/jobs/next");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${baseConfig.token}`,
    );
  });

  it("returns 'empty' on 204", async () => {
    const { fn } = makeFakeFetch({ status: 204 });
    const client = new RunnerApiClient(baseConfig, fn);
    expect(await client.getNext()).toEqual({ kind: "empty" });
  });

  it("throws ApiError on 401", async () => {
    const { fn } = makeFakeFetch({ status: 401, body: { error: "invalid_runner_token" } });
    const client = new RunnerApiClient(baseConfig, fn);
    await expect(client.getNext()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("RunnerApiClient.claim", () => {
  it("returns claimed payload on 200", async () => {
    const payload = {
      jobId: "job-1",
      agentId: "agent-1",
      prompt: "do the thing",
      sessionId: null,
      runtimeConfig: { timeoutSec: 60 },
      promptHash: "h".repeat(64),
    };
    const { fn, calls } = makeFakeFetch({ status: 200, body: payload });
    const client = new RunnerApiClient(baseConfig, fn);
    const res = await client.claim("job-1");
    expect(res).toEqual({ kind: "claimed", payload });
    expect(calls[0].init.method).toBe("POST");
  });

  it("returns 'lost' on 409", async () => {
    const { fn } = makeFakeFetch({ status: 409, body: { error: "job_not_claimable" } });
    const client = new RunnerApiClient(baseConfig, fn);
    expect(await client.claim("job-1")).toEqual({ kind: "lost" });
  });

  it("returns 'gone' on 404", async () => {
    const { fn } = makeFakeFetch({ status: 404, body: { error: "job_not_found" } });
    const client = new RunnerApiClient(baseConfig, fn);
    expect(await client.claim("job-1")).toEqual({ kind: "gone" });
  });
});

describe("RunnerApiClient.appendEvents", () => {
  it("returns ok on 204 (single attempt)", async () => {
    const { fn, calls } = makeFakeFetch({ status: 204 });
    const client = new RunnerApiClient(baseConfig, fn);
    const res = await client.appendEvents("job-1", [
      { eventId: "e1", kind: "stdout_line", ts: "2026-05-04T00:00:00Z", payload: "hi" },
    ]);
    expect(res).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.events).toHaveLength(1);
  });

  it("returns terminal on 409 (job already completed)", async () => {
    const { fn } = makeFakeFetch({ status: 409, body: { error: "job_terminal" } });
    const client = new RunnerApiClient(baseConfig, fn);
    expect(await client.appendEvents("job-1", [
      { eventId: "e1", kind: "stdout_line", ts: "2026-05-04T00:00:00Z", payload: "hi" },
    ])).toEqual({ kind: "terminal" });
  });

  it("no-ops on empty events array", async () => {
    const { fn, calls } = makeFakeFetch({ status: 204 });
    const client = new RunnerApiClient(baseConfig, fn);
    const res = await client.appendEvents("job-1", []);
    expect(res).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(0);
  });
});

describe("RunnerApiClient.complete", () => {
  it("swallows 409 already_terminal as a survivable case", async () => {
    const { fn } = makeFakeFetch({ status: 409, body: { error: "job_already_terminal" } });
    const client = new RunnerApiClient(baseConfig, fn);
    expect(
      await client.complete("job-1", {
        status: "completed",
        exitCode: 0,
        elapsedSec: 1,
        costMicros: 0,
      }),
    ).toEqual({ kind: "already_terminal" });
  });

  it("returns ok on 204", async () => {
    const { fn, calls } = makeFakeFetch({ status: 204 });
    const client = new RunnerApiClient(baseConfig, fn);
    const res = await client.complete("job-1", {
      status: "completed",
      exitCode: 0,
      elapsedSec: 12.5,
      costMicros: 1_500_000,
      sessionId: "sess_abc",
      cliVersion: "claude 0.18.1",
    });
    expect(res).toEqual({ kind: "ok" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({
      status: "completed",
      exitCode: 0,
      sessionId: "sess_abc",
      costMicros: 1_500_000,
    });
  });
});
