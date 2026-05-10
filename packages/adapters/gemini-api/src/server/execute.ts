/**
 * Gemini API adapter — server-side execute function.
 *
 * Resolves the Google API key via instanceApiKeysService (family = 'google'),
 * streams tokens from @google/generative-ai, and maps the result to the
 * standard AdapterExecutionResult shape.
 *
 * Phase C2 multi-provider sprint.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@founderos/adapter-utils";
import { DEFAULT_GEMINI_API_MODEL } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// API key resolver type — injected at call time to avoid process.env mutation
// ---------------------------------------------------------------------------

export type ApiKeyResolver = () => Promise<string | null>;

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
  apiKeyResolver?: ApiKeyResolver,
): Promise<AdapterExecutionResult> {
  const model = asString(ctx.config.model, DEFAULT_GEMINI_API_MODEL);

  // ------------------------------------------------------------------
  // 1. Resolve API key — never fall back to process.env in hosted mode.
  //    Callers inject a resolver that calls
  //    instanceApiKeysService.getDecrypted('google', 'api').
  // ------------------------------------------------------------------
  let apiKey: string | null = null;

  if (typeof apiKeyResolver === "function") {
    apiKey = await apiKeyResolver();
  }

  if (!apiKey) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "no_api_key",
      errorMessage: "Google API key is not configured. Set it via Settings → API Keys.",
    };
  }

  // ------------------------------------------------------------------
  // 2. Build the prompt text from context (mirrors the pattern used by
  //    gemini-local / claude-local adapters).
  // ------------------------------------------------------------------
  const promptTemplate = asString(
    ctx.config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your FounderOS work.",
  );
  // Simple template render: {{agent.id}} → actual value.
  const prompt = promptTemplate
    .replaceAll("{{agent.id}}", ctx.agent.id)
    .replaceAll("{{agent.name}}", ctx.agent.name)
    .replaceAll("{{run.id}}", ctx.runId);

  // ------------------------------------------------------------------
  // 3. Report meta for UI / logging.
  // ------------------------------------------------------------------
  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "gemini_api",
      command: "@google/generative-ai",
      commandArgs: ["generateContentStream", model],
      context: ctx.context,
    });
  }

  await ctx.onLog("stdout", `[gemini-api] model=${model} runId=${ctx.runId}\n`);

  // ------------------------------------------------------------------
  // 4. Stream tokens.
  // ------------------------------------------------------------------
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  const chunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | null = null;

  try {
    const result = await genModel.generateContentStream(prompt);

    for await (const chunk of result.stream) {
      let delta = "";
      try {
        delta = chunk.text();
      } catch {
        // text() throws when the chunk has no text part (e.g. pure function call).
        // Skip silently — do not crash the stream.
      }
      if (delta) {
        chunks.push(delta);
        await ctx.onLog("stdout", delta);
      }
    }

    // Await the aggregated response for usage metadata.
    const aggregated = await result.response;
    const usage = aggregated.usageMetadata;
    if (usage) {
      inputTokens = asNumber(usage.promptTokenCount, 0);
      outputTokens = asNumber(usage.candidatesTokenCount, 0);
      cachedInputTokens = asNumber(usage.cachedContentTokenCount ?? 0, 0);
    }

    // cost_usd — Gemini API does not surface cost in the response.
    // Wrap in try/catch per task spec so future additions don't break.
    try {
      const rawCost = (aggregated as unknown as Record<string, unknown>).costUsd;
      if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
        costUsd = rawCost;
      }
    } catch {
      costUsd = null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[gemini-api] error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "gemini_api_error",
      errorMessage: message,
    };
  }

  // ------------------------------------------------------------------
  // 5. Build result.
  // ------------------------------------------------------------------
  const summary = chunks.join("").trim() || null;

  const usageSummary: UsageSummary | undefined =
    inputTokens > 0 || outputTokens > 0
      ? {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        }
      : undefined;

  await ctx.onLog("stdout", `\n[gemini-api] done runId=${ctx.runId}\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "google",
    biller: "google",
    billingType: "api",
    model,
    ...(usageSummary ? { usage: usageSummary } : {}),
    costUsd,
    ...(summary ? { summary } : {}),
  };
}
