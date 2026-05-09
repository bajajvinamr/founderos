// @vitest-environment jsdom

/**
 * Contract test for `validateProviderKey`.
 *
 * The wizard's live-validation indicator depends on the narrow
 * `{ valid, reason?, aborted? }` shape — every server error path must
 * collapse into one of those three branches. A regression here would
 * either lock the user out (false-negative) or wave a bad key through
 * (false-positive); both are bad for onboarding conversion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateProviderKey, type ProviderId } from "./providers";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function captureFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  requests: CapturedRequest[];
  enqueue: (response: Partial<Response> & { jsonValue?: unknown }) => void;
} {
  const requests: CapturedRequest[] = [];
  const queue: Array<Partial<Response> & { jsonValue?: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as raw string */
      }
    }
    requests.push({ url, method: init?.method ?? "GET", body });

    // Simulate AbortSignal: if the signal is already aborted at
    // dispatch time, throw AbortError. Real fetch does this.
    if (init?.signal?.aborted) {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }

    const next = queue.shift();
    if (!next) {
      throw new Error(`No queued response for ${url}`);
    }

    const status = next.status ?? 200;
    const stub = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.jsonValue,
      headers: { get: () => null },
    };
    return stub as unknown as Response;
  });

  return {
    fetchMock,
    requests,
    enqueue: (response) => queue.push(response),
  };
}

describe("validateProviderKey", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns { valid: true } on 200 happy path", async () => {
    const { fetchMock, requests, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    enqueue({
      status: 200,
      jsonValue: { nonce: "n_1", expiresAt: 9999999999 },
    });
    enqueue({ status: 200, jsonValue: { valid: true } });

    const result = await validateProviderKey("anthropic", "sk-ant-good");

    expect(result).toEqual({ valid: true });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/api/providers/issue-nonce");
    expect(requests[0].method).toBe("GET");
    expect(requests[1].url).toContain("/api/providers/validate-key");
    expect(requests[1].method).toBe("POST");
    expect(requests[1].body).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-good",
      nonce: "n_1",
    });
  });

  it("translates openai_api → openai on the wire", async () => {
    const { fetchMock, requests, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });
    enqueue({ status: 200, jsonValue: { valid: true } });

    await validateProviderKey("openai_api" as ProviderId, "sk-openai");

    const validateBody = requests[1].body as { provider: string };
    expect(validateBody.provider).toBe("openai");
  });

  it("returns { valid: false, reason } on 401 invalid_key", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });
    enqueue({
      status: 401,
      jsonValue: { error: "invalid_key", requestId: "r-1" },
    });

    const result = await validateProviderKey("anthropic", "sk-ant-bad");
    expect(result.valid).toBe(false);
    // 401 hides the precise validator reason on purpose; we surface
    // the error token instead.
    expect(result.reason).toBe("invalid_key");
  });

  it("returns reason='rate_limited' on 429 from validate-key", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });
    enqueue({
      status: 429,
      jsonValue: { error: "provider_rate_limit", retryAfter: 30 },
    });

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result).toEqual({ valid: false, reason: "rate_limited" });
  });

  it("returns reason='rate_limited' on 429 from issue-nonce (before posting key)", async () => {
    const { fetchMock, requests, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 429, jsonValue: { error: "rate_limit_exceeded" } });

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result).toEqual({ valid: false, reason: "rate_limited" });
    // Critical: we never sent the key when the nonce step failed.
    expect(requests).toHaveLength(1);
  });

  it("returns reason='network_error' when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result).toEqual({ valid: false, reason: "network_error" });
  });

  it("returns reason='nonce_failed' when issue-nonce body is malformed", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { not: "the right shape" } });

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result).toEqual({ valid: false, reason: "nonce_failed" });
  });

  it("returns reason='unknown' on 500 with no body", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });
    enqueue({ status: 500, jsonValue: null });

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result).toEqual({ valid: false, reason: "unknown" });
  });

  it("returns reason='empty_key' without making any HTTP call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await validateProviderKey("anthropic", "   ");
    expect(result).toEqual({ valid: false, reason: "empty_key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns { aborted: true } when the signal is aborted before the call", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });

    const controller = new AbortController();
    controller.abort();

    const result = await validateProviderKey(
      "anthropic",
      "sk-ant-x",
      controller.signal,
    );

    expect(result).toEqual({ valid: false, aborted: true });
  });

  it("falls through to validate-key being conservative when 200 body is malformed", async () => {
    const { fetchMock, enqueue } = captureFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    enqueue({ status: 200, jsonValue: { nonce: "n_1", expiresAt: 1 } });
    // Server returned 200 but body shape is wrong — wizard MUST treat
    // this as invalid (defense against a misconfigured proxy returning
    // a generic 200 page).
    enqueue({ status: 200, jsonValue: { valid: false, reason: "weird" } });

    const result = await validateProviderKey("anthropic", "sk-ant-x");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("unknown");
  });
});
