/**
 * Tests for the Anthropic API adapter execute() function.
 *
 * Covers:
 *  - execute() with no key configured -> returns errorCode 'no_api_key', no API call fires
 *  - execute() with key configured -> mocks the Anthropic client, asserts token streaming
 *  - execute() cleanup/error handling on stream error
 *  - cost_usd extraction returns null on missing usage / unknown model
 *  - adaptive-thinking default is applied on opus/sonnet, omitted on haiku, overridable via config.thinking
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@founderos/adapter-utils";

// ---- @anthropic-ai/sdk module mock ----
// We mock the module BEFORE importing execute so the lazy import inside
// execute() gets the mock instead of the real package.
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn(() => ({
    messages: {
      create: mockCreate,
    },
  }));
  (MockAnthropic as unknown as Record<string, unknown>)._mockCreate =
    mockCreate;
  return { default: MockAnthropic };
});

async function getAnthropicMock() {
  const mod = await import("@anthropic-ai/sdk");
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

function makeCtx(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-test-1",
    agent: {
      id: "agent-1",
      companyId: "co-test",
      name: "Test Agent",
      adapterType: "anthropic_api",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "claude-opus-4-7",
      promptTemplate: "You are agent {{agent.id}}. Do the work.",
    },
    context: {},
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Build a standard message_start / content_block_delta / message_delta
 * sequence shaped like the real Anthropic stream.
 */
function streamEvents(opts: {
  model?: string;
  textChunks?: string[];
  startUsage?: Record<string, unknown> | null;
  deltaUsage?: Record<string, unknown> | null;
}): unknown[] {
  const model = opts.model ?? "claude-opus-4-7-20260229";
  const events: unknown[] = [];
  events.push({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: opts.startUsage ?? { input_tokens: 10 },
    },
  });
  events.push({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const chunk of opts.textChunks ?? []) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
  }
  events.push({ type: "content_block_stop", index: 0 });
  events.push({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: opts.deltaUsage ?? { output_tokens: 5 },
  });
  events.push({ type: "message_stop" });
  return events;
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
    const mockCreate = await getAnthropicMock();

    const ctx = makeCtx({
      config: {
        promptTemplate: "Should not call API.",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(result.errorMessage).toContain("Anthropic API key");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns errorCode no_api_key when resolver returns null", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

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
    const mockCreate = await getAnthropicMock();

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

  it("returns errorCode no_api_key when resolver throws", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    const ctx = makeCtx({
      config: {
        apiKeyResolver: async () => {
          throw new Error("DB unreachable");
        },
      },
    });

    const result = await execute(ctx);

    expect(result.errorCode).toBe("no_api_key");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("execute() — with key configured, mocked client", () => {
  it("streams text tokens via onLog and returns exitCode 0", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          model: "claude-opus-4-7-20260229",
          textChunks: ["Hello", ", world!"],
          startUsage: { input_tokens: 20 },
          deltaUsage: { output_tokens: 5 },
        }),
      ),
    );

    const logs: string[] = [];
    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        promptTemplate: "Do the work.",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
      onLog: vi.fn(async (_stream: string, chunk: string) => {
        logs.push(chunk);
      }),
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.provider).toBe("anthropic");
    expect(result.biller).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-7-20260229");
    expect(result.billingType).toBe("api");
    expect(result.summary).toBe("Hello, world!");

    expect(logs.some((l) => l.includes("Hello"))).toBe(true);
    expect(logs.some((l) => l.includes(", world!"))).toBe(true);

    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("calls messages.create with stream: true and the expected shape", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          textChunks: ["done"],
          startUsage: { input_tokens: 5 },
          deltaUsage: { output_tokens: 1 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        promptTemplate: "Test prompt.",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    await execute(ctx);

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.stream).toBe(true);
    expect(callArg.model).toBe("claude-opus-4-7");
    expect(callArg.max_tokens).toBeTypeOf("number");
    expect(Array.isArray(callArg.messages)).toBe(true);
  });

  it("applies adaptive-thinking default on opus models", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          textChunks: ["ok"],
          startUsage: { input_tokens: 5 },
          deltaUsage: { output_tokens: 1 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    await execute(ctx);
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.thinking).toEqual({ type: "adaptive" });
  });

  it("omits thinking on haiku models by default", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          textChunks: ["ok"],
          startUsage: { input_tokens: 5 },
          deltaUsage: { output_tokens: 1 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-haiku-4-5",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    await execute(ctx);
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.thinking).toBeUndefined();
  });

  it("respects explicit config.thinking = null (disables thinking)", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          textChunks: ["ok"],
          startUsage: { input_tokens: 5 },
          deltaUsage: { output_tokens: 1 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        thinking: null,
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    await execute(ctx);
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.thinking).toBeUndefined();
  });

  it("returns errorCode anthropic_api_error on stream throw", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    async function* failingStream() {
      yield {
        type: "message_start",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 5 },
        },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      };
      throw new Error("Rate limit exceeded");
    }

    mockCreate.mockResolvedValue(failingStream());

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("anthropic_api_error");
    expect(result.errorMessage).toContain("Rate limit exceeded");
    expect(result.timedOut).toBe(false);
  });

  it("returns errorCode anthropic_api_error when create itself rejects", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockRejectedValue(new Error("Authentication error"));

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        apiKeyResolver: async () => "sk-ant-bad-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("anthropic_api_error");
    expect(result.errorMessage).toContain("Authentication error");
  });
});

describe("execute() — cost_usd extraction", () => {
  it("returns costUsd=null when no usage observed at all", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable([
        {
          type: "message_start",
          message: { model: "claude-opus-4-7", usage: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeNull();
  });

  it("returns numeric costUsd for known model with usage", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          model: "claude-opus-4-7-20260229",
          textChunks: ["answer"],
          startUsage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 200,
          },
          deltaUsage: { output_tokens: 500 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-opus-4-7",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(typeof result.costUsd).toBe("number");
    expect(result.costUsd).not.toBeNull();
    expect(result.costUsd).toBeGreaterThan(0);
    // Cached input tokens should be in the usage summary
    expect(result.usage?.cachedInputTokens).toBe(200);
    // Total inputTokens includes both regular and cached
    expect(result.usage?.inputTokens).toBe(1200);
  });

  it("returns costUsd=null for unknown model id", async () => {
    const { execute } = await import("../execute.js");
    const mockCreate = await getAnthropicMock();

    mockCreate.mockResolvedValue(
      makeAsyncIterable(
        streamEvents({
          model: "claude-experimental-5",
          textChunks: ["ok"],
          startUsage: { input_tokens: 100 },
          deltaUsage: { output_tokens: 50 },
        }),
      ),
    );

    const ctx = makeCtx({
      config: {
        model: "claude-experimental-5",
        apiKeyResolver: async () => "sk-ant-test-key",
      },
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBeNull();
    // But usage tokens are still tracked
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });
});
