/**
 * Tests for the OpenAI API adapter execute() function.
 *
 * Covers:
 *  - execute() with no key configured → returns errorCode 'no_api_key', no API call fires
 *  - execute() with key configured → mocks the openai client, asserts token streaming
 *  - execute() cleanup/error handling on stream error
 *  - cost_usd extraction returns null on missing usage field
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@founderos/adapter-utils";

// ---- OpenAI module mock ----
// We mock the 'openai' module BEFORE importing execute so the lazy import
// inside execute() gets the mock instead of the real package.
vi.mock("openai", () => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
  // Expose the mockCreate so tests can configure it
  (MockOpenAI as unknown as Record<string, unknown>)._mockCreate = mockCreate;
  return { default: MockOpenAI };
});

async function getOpenAIMock() {
  const mod = await import("openai");
  const Ctor = mod.default as unknown as {
    _mockCreate: ReturnType<typeof vi.fn>;
  };
  return Ctor._mockCreate;
}

function makeAsyncIterable(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next() {
          if (index < chunks.length) {
            return Promise.resolve({ value: chunks[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-1",
    agent: {
      id: "agent-1",
      companyId: "co-test",
      name: "Test Agent",
      adapterType: "openai_api",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "gpt-4o",
      promptTemplate: "You are agent {{agent.id}}. Do the work.",
    },
    context: {},
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("execute() — no API key configured", () => {
  it("returns errorCode no_api_key when no apiKeyResolver is provided", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    const ctx = makeCtx({
      config: {
        promptTemplate: "Should not call API.",
        // No apiKeyResolver
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(result.errorMessage).toContain("OpenAI API key");
    // Must NOT have called the API
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns errorCode no_api_key when resolver returns null", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    let resolverCallCount = 0;
    const ctx = makeCtx({
      config: {
        promptTemplate: "Should not call API.",
        apiKeyResolver: async () => {
          resolverCallCount++;
          return null;
        },
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(resolverCallCount).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns errorCode no_api_key when resolver returns empty string", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    const ctx = makeCtx({
      config: {
        apiKeyResolver: async () => "   ",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("execute() — with key configured, mocked client", () => {
  it("streams tokens via onLog and returns exitCode 0", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    const streamChunks = [
      {
        model: "gpt-4o-2024-08-06",
        choices: [{ delta: { content: "Hello" } }],
        usage: null,
      },
      {
        model: "gpt-4o-2024-08-06",
        choices: [{ delta: { content: ", world!" } }],
        usage: null,
      },
      {
        model: "gpt-4o-2024-08-06",
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    ];

    mockCreate.mockResolvedValue(makeAsyncIterable(streamChunks));

    const logs: string[] = [];
    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Do the work.",
        apiKeyResolver: async () => "sk-test-key-123",
      },
      onLog: vi.fn(async (_stream: string, chunk: string) => {
        logs.push(chunk);
      }),
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.provider).toBe("openai");
    expect(result.biller).toBe("openai");
    expect(result.model).toBe("gpt-4o-2024-08-06");
    expect(result.billingType).toBe("api");
    expect(result.summary).toBe("Hello, world!");

    // Token streaming should have included the content tokens in logs
    expect(logs.some((l) => l.includes("Hello"))).toBe(true);
    expect(logs.some((l) => l.includes(", world!"))).toBe(true);

    // Usage should be populated
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("calls client.chat.completions.create with stream: true", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          model: "gpt-4o",
          choices: [{ delta: { content: "done" } }],
          usage: null,
        },
        {
          model: "gpt-4o",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        },
      ]),
    );

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test prompt.",
        apiKeyResolver: async () => "sk-test-key",
      },
    });

    await execute(ctx);

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.stream).toBe(true);
    expect(callArg.model).toBe("gpt-4o");
    expect(Array.isArray(callArg.messages)).toBe(true);
  });

  it("returns errorCode openai_api_error on stream throw", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    // Make the stream throw after a couple chunks
    async function* failingStream() {
      yield {
        model: "gpt-4o",
        choices: [{ delta: { content: "partial" } }],
        usage: null,
      };
      throw new Error("Rate limit exceeded");
    }

    mockCreate.mockResolvedValue(failingStream());

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => "sk-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_api_error");
    expect(result.errorMessage).toContain("Rate limit exceeded");
    expect(result.timedOut).toBe(false);
  });

  it("returns errorCode openai_api_error when create itself rejects", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    mockCreate.mockRejectedValue(new Error("Authentication error"));

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => "sk-bad-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_api_error");
    expect(result.errorMessage).toContain("Authentication error");
  });
});

describe("execute() — cost_usd extraction", () => {
  it("returns costUsd=null when OpenAI emits no usage field", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    // No usage field in any chunk
    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          model: "gpt-4o",
          choices: [{ delta: { content: "ok" } }],
          usage: null,
        },
        {
          model: "gpt-4o",
          choices: [{ delta: {} }],
          // No usage
        },
      ]),
    );

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => "sk-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeNull();
  });

  it("returns a numeric costUsd when usage is present", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          model: "gpt-4o",
          choices: [{ delta: { content: "answer" } }],
          usage: null,
        },
        {
          model: "gpt-4o",
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            prompt_tokens_details: { cached_tokens: 200 },
          },
        },
      ]),
    );

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => "sk-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(typeof result.costUsd).toBe("number");
    expect(result.costUsd).not.toBeNull();
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// L2-A08 — positional apiKeyResolver harmonization with gemini-api
// ---------------------------------------------------------------------------
describe("execute() — positional apiKeyResolver (L2-A08 harmonization)", () => {
  it("execute.length === 2 — positional resolver is part of the signature", async () => {
    const { execute } = await import("../execute.js");
    expect(execute.length).toBe(2);
  });

  it("uses the positional resolver and skips the API call when it returns null", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    let positionalCalls = 0;
    const ctx = makeCtx({ config: { promptTemplate: "Should not call API." } });

    const result = await execute(ctx, async () => {
      positionalCalls++;
      return null;
    });

    expect(positionalCalls).toBe(1);
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("positional resolver wins over config.apiKeyResolver when both supplied", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          model: "gpt-4o",
          choices: [{ delta: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ]),
    );

    let positionalCalls = 0;
    let legacyCalls = 0;

    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => {
          legacyCalls++;
          return "sk-legacy-should-be-ignored";
        },
      },
    });

    const result = await execute(ctx, async () => {
      positionalCalls++;
      return "sk-positional-wins";
    });

    expect(positionalCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it("falls back to config.apiKeyResolver when no positional arg is supplied", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          model: "gpt-4o",
          choices: [{ delta: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ]),
    );

    let legacyCalls = 0;
    const ctx = makeCtx({
      config: {
        model: "gpt-4o",
        promptTemplate: "Test.",
        apiKeyResolver: async () => {
          legacyCalls++;
          return "sk-legacy-key";
        },
      },
    });

    const result = await execute(ctx);

    expect(legacyCalls).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("treats positional resolver throwing as no_api_key without falling back to legacy", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getOpenAIMock();

    let legacyCalls = 0;
    const ctx = makeCtx({
      config: {
        apiKeyResolver: async () => {
          legacyCalls++;
          return "sk-should-not-be-used";
        },
      },
    });

    const result = await execute(ctx, async () => {
      throw new Error("vault unreachable");
    });

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(legacyCalls).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
