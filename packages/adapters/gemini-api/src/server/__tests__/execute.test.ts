/**
 * Tests for the Gemini API adapter execute() function.
 *
 * Covers:
 *  - execute() with no key → returns errorCode 'no_api_key' without SDK calls
 *  - execute() with key → mocks SDK, asserts streaming and result shape
 *  - cost_usd extraction safety (null when absent, value when present)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@founderos/adapter-utils";

// ---------------------------------------------------------------------------
// Mock @google/generative-ai before importing execute
// ---------------------------------------------------------------------------
const mockText = vi.fn<() => string>();
const mockStreamChunks: Array<{ text: () => string }> = [];

const mockResponse = {
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 20,
    cachedContentTokenCount: 0,
  },
  costUsd: undefined as number | undefined,
};

const mockGenerateContentStream = vi.fn(async () => ({
  stream: (async function* () {
    for (const chunk of mockStreamChunks) {
      yield chunk;
    }
  })(),
  response: Promise.resolve(mockResponse),
}));

const mockGetGenerativeModel = vi.fn(() => ({
  generateContentStream: mockGenerateContentStream,
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

import { execute } from "../execute.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-1",
    agent: { id: "agent-1", companyId: "co-1", name: "TestAgent", adapterType: "gemini_api", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { model: "gemini-2.5-pro" },
    context: {},
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("execute() — no API key", () => {
  it("returns errorCode 'no_api_key' when no resolver is provided", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(result.errorMessage).toContain("Google API key");
    // SDK must not have been called.
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });

  it("returns errorCode 'no_api_key' when resolver returns null", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx, async () => null);
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("no_api_key");
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });
});

describe("execute() — with API key (streaming)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamChunks.length = 0;
    mockResponse.costUsd = undefined;
    mockResponse.usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 0,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateContentStream and returns exitCode 0 on success", async () => {
    mockStreamChunks.push({ text: () => "Hello" }, { text: () => " world" });

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(mockGenerateContentStream).toHaveBeenCalledOnce();
  });

  it("streams token chunks via onLog stdout", async () => {
    mockStreamChunks.push({ text: () => "chunk-A" }, { text: () => "chunk-B" });
    const logCalls: Array<[string, string]> = [];
    const ctx = makeCtx({
      onLog: vi.fn(async (stream, chunk) => { logCalls.push([stream, chunk]); }),
    });

    await execute(ctx, async () => "fake-google-api-key");

    const stdoutChunks = logCalls.filter(([s]) => s === "stdout").map(([, c]) => c);
    expect(stdoutChunks).toContain("chunk-A");
    expect(stdoutChunks).toContain("chunk-B");
  });

  it("returns summary as concatenated stream chunks", async () => {
    mockStreamChunks.push({ text: () => "Hello" }, { text: () => " world" });

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.summary).toBe("Hello world");
  });

  it("returns usage tokens from usageMetadata", async () => {
    mockStreamChunks.push({ text: () => "response" });
    mockResponse.usageMetadata = {
      promptTokenCount: 42,
      candidatesTokenCount: 17,
      cachedContentTokenCount: 5,
    };

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17, cachedInputTokens: 5 });
  });

  it("omits cachedInputTokens when cachedContentTokenCount is 0", async () => {
    mockStreamChunks.push({ text: () => "response" });
    mockResponse.usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 0,
    };

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.usage?.cachedInputTokens).toBeUndefined();
  });

  it("sets provider='google' and billingType='api'", async () => {
    mockStreamChunks.push({ text: () => "ok" });

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.provider).toBe("google");
    expect(result.biller).toBe("google");
    expect(result.billingType).toBe("api");
  });

  it("uses model from config, defaulting to gemini-2.5-pro", async () => {
    mockStreamChunks.push({ text: () => "ok" });
    const ctx = makeCtx({ config: {} });
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.model).toBe("gemini-2.5-pro");
    expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: "gemini-2.5-pro" });
  });

  it("uses model override from config when provided", async () => {
    mockStreamChunks.push({ text: () => "ok" });
    const ctx = makeCtx({ config: { model: "gemini-1.5-flash" } });
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.model).toBe("gemini-1.5-flash");
    expect(mockGetGenerativeModel).toHaveBeenCalledWith({ model: "gemini-1.5-flash" });
  });

  it("returns exitCode 1 when SDK throws", async () => {
    mockGenerateContentStream.mockRejectedValueOnce(new Error("quota exceeded"));

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("gemini_api_error");
    expect(result.errorMessage).toContain("quota exceeded");
  });
});

describe("execute() — cost_usd extraction safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreamChunks.length = 0;
    mockResponse.usageMetadata = {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      cachedContentTokenCount: 0,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns costUsd=null when costUsd is absent from response", async () => {
    mockStreamChunks.push({ text: () => "ok" });
    mockResponse.costUsd = undefined;

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.costUsd).toBeNull();
  });

  it("returns costUsd value when present on aggregated response", async () => {
    mockStreamChunks.push({ text: () => "ok" });
    mockResponse.costUsd = 0.0042;

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.costUsd).toBe(0.0042);
  });

  it("returns costUsd=null when costUsd is non-finite (safety guard)", async () => {
    mockStreamChunks.push({ text: () => "ok" });
    (mockResponse as Record<string, unknown>).costUsd = NaN;

    const ctx = makeCtx();
    const result = await execute(ctx, async () => "fake-google-api-key");

    expect(result.costUsd).toBeNull();
  });
});
