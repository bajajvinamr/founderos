import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@founderos/adapter-utils";
import { asString, asNumber } from "@founderos/adapter-utils/server-utils";

/**
 * Resolver shape supplied via `config.apiKeyResolver` for Anthropic hosted runs.
 * Mirrors the OpenAIKeyResolver / AnthropicKeyResolver pattern across the
 * adapter family: `instanceApiKeysService.getDecrypted('anthropic', 'api')`.
 */
type AnthropicKeyResolver = (
  family: "anthropic",
  executionMode: "api",
) => Promise<string | null>;

const DEFAULT_MODEL = "claude-opus-4-7";

/**
 * Per-1M-token pricing in USD. Matches the public Anthropic pricing page
 * cached in the claude-api skill (verified 2026-04-29). `cachedInput` is
 * the prompt-cache READ rate (10% of input). Cache writes are billed at
 * 1.25x input rate inside `estimateCostUsd()`.
 *
 * Unknown model ids return null cost (do not guess across families).
 */
const PRICING_PER_1M: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "claude-opus-4-7": { input: 5, cachedInput: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cachedInput: 0.5, output: 25 },
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5 },
};

/**
 * Models that support `thinking: {type: "adaptive"}` without a 400.
 * Used to gate the default-thinking injection. User can always override
 * via explicit `config.thinking` (including `null` to disable).
 */
const ADAPTIVE_THINKING_PREFIXES = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookupPricing(
  model: string,
): { input: number; cachedInput: number; output: number } | null {
  // Exact match first
  if (PRICING_PER_1M[model]) return PRICING_PER_1M[model];
  // Prefix match for date-versioned ids like `claude-opus-4-7-YYYYMMDD`
  for (const [prefix, prices] of Object.entries(PRICING_PER_1M)) {
    if (model.startsWith(prefix + "-")) return prices;
  }
  return null;
}

function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_PREFIXES.some(
    (p) => model === p || model.startsWith(p + "-"),
  );
}

function extractNumber(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number {
  if (!source) return 0;
  const v = source[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

function emptyUsage(): AnthropicUsage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

function mergeUsage(
  acc: AnthropicUsage,
  raw: Record<string, unknown> | null | undefined,
): AnthropicUsage {
  if (!raw) return acc;
  return {
    input_tokens: acc.input_tokens + extractNumber(raw, "input_tokens"),
    cache_creation_input_tokens:
      acc.cache_creation_input_tokens +
      extractNumber(raw, "cache_creation_input_tokens"),
    cache_read_input_tokens:
      acc.cache_read_input_tokens +
      extractNumber(raw, "cache_read_input_tokens"),
    output_tokens: acc.output_tokens + extractNumber(raw, "output_tokens"),
  };
}

/**
 * Estimate cost_usd from Anthropic-shaped usage. Returns null for unknown
 * models (don't guess) or on any computation failure.
 *
 * Pricing model:
 *   - regular input: input_tokens at 1.0x input rate
 *   - cache creation: cache_creation_input_tokens at 1.25x input rate (Anthropic write surcharge)
 *   - cache read: cache_read_input_tokens at 0.1x input rate (cachedInput column)
 *   - output: output_tokens at output rate
 */
function estimateCostUsd(model: string, usage: AnthropicUsage): number | null {
  const pricing = lookupPricing(model);
  if (!pricing) return null;
  try {
    const regular = (usage.input_tokens / 1_000_000) * pricing.input;
    const cacheCreate =
      (usage.cache_creation_input_tokens / 1_000_000) * pricing.input * 1.25;
    const cacheRead =
      (usage.cache_read_input_tokens / 1_000_000) * pricing.cachedInput;
    const output = (usage.output_tokens / 1_000_000) * pricing.output;
    const total = regular + cacheCreate + cacheRead + output;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  // --- API key resolution (fail fast before any import or API call) ---
  const apiKeyResolver = config.apiKeyResolver as
    | AnthropicKeyResolver
    | undefined;
  let resolvedKey: string | null = null;
  if (typeof apiKeyResolver === "function") {
    try {
      resolvedKey = await apiKeyResolver("anthropic", "api");
    } catch {
      resolvedKey = null;
    }
  }
  if (!resolvedKey || resolvedKey.trim().length === 0) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "no_api_key",
      errorMessage: "Anthropic API key not configured for this instance",
    };
  }
  const apiKey = resolvedKey;

  const model = asString(config.model, DEFAULT_MODEL) || DEFAULT_MODEL;
  const timeoutSec = asNumber(config.timeoutSec, 120);
  const maxTokens = asNumber(config.maxTokens, 4096);

  // Build prompt
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your FounderOS work.",
  );
  const prompt = promptTemplate
    .replace(/\{\{agent\.id\}\}/g, agent.id)
    .replace(/\{\{agent\.name\}\}/g, agent.name)
    .replace(/\{\{agent\.companyId\}\}/g, agent.companyId);

  // Thinking config — adaptive by default on opus/sonnet 4.6+ models.
  // Explicit `config.thinking === null` disables. Any other explicit value
  // (including {type: "disabled"} or {type: "enabled", budget_tokens: N})
  // is passed through verbatim.
  let thinkingParam: Record<string, unknown> | null;
  if (config.thinking === null) {
    thinkingParam = null;
  } else if (config.thinking !== undefined) {
    thinkingParam = isRecord(config.thinking) ? config.thinking : null;
  } else if (supportsAdaptiveThinking(model)) {
    thinkingParam = { type: "adaptive" };
  } else {
    thinkingParam = null;
  }

  if (onMeta) {
    await onMeta({
      adapterType: "anthropic_api",
      command: "anthropic.messages.create",
      commandArgs: ["--model", model, "--stream"],
      context,
    });
  }

  await onLog(
    "stdout",
    `[anthropic-api] starting run=${runId} model=${model}\n`,
  );

  // Lazy-import the @anthropic-ai/sdk package to avoid loading it on the
  // no_api_key path (and to mirror the openai-api adapter's lazy-load
  // pattern so tests can mock-vi.mock before import resolves).
  let Anthropic: typeof import("@anthropic-ai/sdk").default;
  try {
    const mod = await import("@anthropic-ai/sdk");
    Anthropic = mod.default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "anthropic_package_missing",
      errorMessage: `Failed to load @anthropic-ai/sdk package: ${msg}`,
    };
  }

  const client = new Anthropic({ apiKey });

  const assistantChunks: string[] = [];
  let resolvedModel: string = model;
  let usage: AnthropicUsage = emptyUsage();
  let timedOut = false;

  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  if (timeoutMs > 0) {
    abortController = new AbortController();
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController!.abort();
    }, timeoutMs);
  }

  try {
    // Build the request. Anthropic's SDK is strict about which fields are
    // present — only attach `thinking` when we have a concrete object.
    const createParams: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    };
    if (thinkingParam !== null) {
      createParams.thinking = thinkingParam;
    }

    // The SDK's `messages.create({stream: true, ...})` returns an
    // AsyncIterable<RawMessageStreamEvent>. Each event is one of:
    //   message_start | content_block_start | content_block_delta |
    //   content_block_stop | message_delta | message_stop | ping
    const stream = (await client.messages.create(
      createParams as unknown as Parameters<typeof client.messages.create>[0],
      abortController ? { signal: abortController.signal } : {},
    )) as AsyncIterable<Record<string, unknown>>;

    for await (const event of stream) {
      if (timedOut) break;

      const eventType = typeof event.type === "string" ? event.type : null;

      // message_start carries the assigned model + initial input usage
      if (eventType === "message_start" && isRecord(event.message)) {
        const message = event.message;
        if (typeof message.model === "string" && message.model.length > 0) {
          resolvedModel = message.model;
        }
        if (isRecord(message.usage)) {
          usage = mergeUsage(usage, message.usage);
        }
      }

      // content_block_delta with delta.type === "text_delta" carries text
      if (eventType === "content_block_delta" && isRecord(event.delta)) {
        const delta = event.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          assistantChunks.push(delta.text);
          await onLog("stdout", delta.text);
        }
        // thinking deltas (delta.type === "thinking_delta") are intentionally
        // dropped from the run log — they're reasoning, not user-visible output.
      }

      // message_delta carries the final output usage
      if (eventType === "message_delta" && isRecord(event.usage)) {
        usage = mergeUsage(usage, event.usage);
      }
    }
  } catch (err) {
    if (timedOut) {
      await onLog("stderr", `[anthropic-api] timed out after ${timeoutSec}s\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorCode: "timeout",
        errorMessage: `Anthropic API run timed out after ${timeoutSec}s`,
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[anthropic-api] error: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "anthropic_api_error",
      errorMessage: msg,
    };
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }

  if (timedOut) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "timeout",
      errorMessage: `Anthropic API run timed out after ${timeoutSec}s`,
    };
  }

  const summary = assistantChunks.join("").trim();

  // Map Anthropic usage shape to the platform UsageSummary shape.
  // - inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  //   (total prompt size, including any cached reads — matches the OpenAI shape
  //   where prompt_tokens is the full processed prompt)
  // - cachedInputTokens = cache_read_input_tokens (the "freebie" portion)
  // - outputTokens = output_tokens
  const totalInputTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  const cachedInputTokens = usage.cache_read_input_tokens;
  const outputTokens = usage.output_tokens;

  // Cost estimation — only attempt if we observed token counts.
  let costUsd: number | null = null;
  const sawAnyUsage =
    totalInputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  if (sawAnyUsage) {
    try {
      costUsd = estimateCostUsd(resolvedModel, usage);
    } catch {
      costUsd = null;
    }
  }

  const usageSummary =
    totalInputTokens > 0 || outputTokens > 0
      ? {
          inputTokens: totalInputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        }
      : undefined;

  await onLog(
    "stdout",
    `[anthropic-api] completed run=${runId} model=${resolvedModel} inputTokens=${totalInputTokens} outputTokens=${outputTokens}\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "anthropic",
    biller: "anthropic",
    model: resolvedModel,
    billingType: "api",
    ...(usageSummary ? { usage: usageSummary } : {}),
    ...(costUsd !== null ? { costUsd } : { costUsd: null }),
    summary: summary || null,
    resultJson: {
      summary,
      model: resolvedModel,
      usage: {
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        output_tokens: usage.output_tokens,
      },
    },
  };
}
