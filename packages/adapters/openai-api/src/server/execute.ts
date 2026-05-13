import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@founderos/adapter-utils";
import { asString, asNumber } from "@founderos/adapter-utils/server-utils";

/**
 * API key resolver — injected at call time by the server adapter registry.
 *
 * Shape is identical to the gemini-api `ApiKeyResolver` (no-arg, returns the
 * decrypted key or null). The server passes a closure that calls
 * `instanceApiKeysService.getDecrypted('openai', 'api')` per-run; no
 * process.env fallback. This is the second positional arg of execute().
 *
 * L2-A08 (2026-05-13): harmonized to match gemini's positional-arg pattern
 * established by PR #198 (TA01+TA02). The legacy `config.apiKeyResolver`
 * inline shape — `(family, executionMode) => Promise<string|null>` — is
 * still accepted as a fallback so existing callers and tests keep working;
 * the positional arg takes precedence when both are supplied.
 */
export type ApiKeyResolver = () => Promise<string | null>;

/** Legacy resolver shape carried via `config.apiKeyResolver`. Pre-L2-A08,
 *  this was the only injection point. Retained for backward compat. */
type LegacyConfigKeyResolver = (
  family: "openai",
  executionMode: "api",
) => Promise<string | null>;

const DEFAULT_MODEL = "gpt-4o";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function extractInputTokens(usage: Record<string, unknown>): number {
  const v = usage.prompt_tokens;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

function extractOutputTokens(usage: Record<string, unknown>): number {
  const v = usage.completion_tokens;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

function extractCachedInputTokens(usage: Record<string, unknown>): number {
  // OpenAI returns cached token count under usage.prompt_tokens_details.cached_tokens
  // or directly under usage.cached_tokens (older shape).
  const details = usage.prompt_tokens_details;
  if (isRecord(details)) {
    const v = details.cached_tokens;
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  }
  const direct = usage.cached_tokens;
  if (typeof direct === "number" && Number.isFinite(direct))
    return Math.max(0, direct);
  return 0;
}

/**
 * Estimate cost_usd from token counts using GPT-4o pricing as a fallback.
 * Returns null on any access failure (council R1 Gemini P3 pattern).
 */
function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number | null {
  try {
    // GPT-4o pricing (2024): $2.50/1M input, $1.25/1M cached input, $10/1M output
    const inputCost = ((inputTokens - cachedInputTokens) / 1_000_000) * 2.5;
    const cachedCost = (cachedInputTokens / 1_000_000) * 1.25;
    const outputCost = (outputTokens / 1_000_000) * 10;
    const total = inputCost + cachedCost + outputCost;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
  apiKeyResolver?: ApiKeyResolver,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  // --- API key resolution (fail fast before any import or API call) ---
  // L2-A08: prefer the positional second-arg resolver (matches gemini_api's
  // pattern). Fall back to config.apiKeyResolver for backward compat with
  // call sites that have not yet migrated.
  let resolvedKey: string | null = null;
  if (typeof apiKeyResolver === "function") {
    try {
      resolvedKey = await apiKeyResolver();
    } catch {
      resolvedKey = null;
    }
  } else {
    const legacyResolver = config.apiKeyResolver as
      | LegacyConfigKeyResolver
      | undefined;
    if (typeof legacyResolver === "function") {
      try {
        resolvedKey = await legacyResolver("openai", "api");
      } catch {
        resolvedKey = null;
      }
    }
  }
  if (!resolvedKey || resolvedKey.trim().length === 0) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "no_api_key",
      errorMessage: "OpenAI API key not configured for this instance",
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

  if (onMeta) {
    await onMeta({
      adapterType: "openai_api",
      command: "openai.chat.completions.create",
      commandArgs: ["--model", model, "--stream"],
      context,
    });
  }

  await onLog(
    "stdout",
    `[openai-api] starting run=${runId} model=${model}\n`,
  );

  // Lazy-import the openai package to avoid loading it on the no_api_key path
  let OpenAI: typeof import("openai").default;
  try {
    const mod = await import("openai");
    OpenAI = mod.default;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "openai_package_missing",
      errorMessage: `Failed to load openai package: ${msg}`,
    };
  }

  const client = new OpenAI({ apiKey });

  const assistantChunks: string[] = [];
  let usageRecord: Record<string, unknown> | null = null;
  let resolvedModel: string = model;
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
    const stream = await client.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: prompt }],
      },
      abortController ? { signal: abortController.signal } : {},
    );

    for await (const chunk of stream) {
      if (timedOut) break;

      // Capture the final model value from the first chunk that has it
      if (chunk.model && chunk.model.length > 0) {
        resolvedModel = chunk.model;
      }

      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        assistantChunks.push(delta);
        await onLog("stdout", delta);
      }

      // usage is only present on the final chunk when include_usage is set
      if (chunk.usage && isRecord(chunk.usage)) {
        usageRecord = chunk.usage as Record<string, unknown>;
      }
    }
  } catch (err) {
    if (timedOut) {
      await onLog(
        "stderr",
        `[openai-api] timed out after ${timeoutSec}s\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorCode: "timeout",
        errorMessage: `OpenAI API run timed out after ${timeoutSec}s`,
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[openai-api] error: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "openai_api_error",
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
      errorMessage: `OpenAI API run timed out after ${timeoutSec}s`,
    };
  }

  const summary = assistantChunks.join("").trim();

  // Usage extraction — only attempt if OpenAI returned a usage record.
  // If no usage record was received, all fields default to zero / null.
  const inputTokens = usageRecord ? extractInputTokens(usageRecord) : 0;
  const outputTokens = usageRecord ? extractOutputTokens(usageRecord) : 0;
  const cachedInputTokens = usageRecord
    ? extractCachedInputTokens(usageRecord)
    : 0;

  // Council R1 Gemini P3 pattern — wrap cost_usd extraction in try/catch.
  // Return null when there is no usage record (no token counts available).
  let costUsd: number | null = null;
  if (usageRecord) {
    try {
      costUsd = estimateCostUsd(inputTokens, outputTokens, cachedInputTokens);
    } catch {
      costUsd = null;
    }
  }

  const usage =
    inputTokens > 0 || outputTokens > 0
      ? {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        }
      : undefined;

  await onLog(
    "stdout",
    `[openai-api] completed run=${runId} model=${resolvedModel} inputTokens=${inputTokens} outputTokens=${outputTokens}\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "openai",
    biller: "openai",
    model: resolvedModel,
    billingType: "api",
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : { costUsd: null }),
    summary: summary || null,
    resultJson: {
      summary,
      model: resolvedModel,
      ...(usageRecord ?? {}),
    },
  };
}
