import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@founderos/adapter-utils";
import { parseObject } from "@founderos/adapter-utils/server-utils";
import { DEFAULT_ANTHROPIC_API_MODEL, models } from "../index.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const modelRaw = config.model;
  if (modelRaw === undefined || modelRaw === null || modelRaw === "") {
    checks.push({
      code: "anthropic_api_model_default",
      level: "info",
      message: `Using default model: ${DEFAULT_ANTHROPIC_API_MODEL}`,
    });
  } else if (typeof modelRaw !== "string") {
    checks.push({
      code: "anthropic_api_model_invalid",
      level: "error",
      message: "config.model must be a string",
    });
  } else {
    const known =
      models.some((m) => m.id === modelRaw) ||
      models.some((m) => modelRaw.startsWith(m.id + "-"));
    checks.push({
      code: known
        ? "anthropic_api_model_configured"
        : "anthropic_api_model_custom",
      level: known ? "info" : "warn",
      message: known
        ? `Configured model: ${modelRaw}`
        : `Custom model id not in the known list: ${modelRaw}`,
      hint: known
        ? undefined
        : "Anthropic may reject unknown model ids at run time. Verify the model exists in your account, or use one of: " +
          models.map((m) => m.id).join(", "),
    });
  }

  const timeoutRaw = config.timeoutSec;
  if (timeoutRaw !== undefined) {
    const n =
      typeof timeoutRaw === "number"
        ? timeoutRaw
        : typeof timeoutRaw === "string"
          ? Number(timeoutRaw)
          : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      checks.push({
        code: "anthropic_api_timeout_invalid",
        level: "error",
        message: "config.timeoutSec must be a positive number",
      });
    }
  }

  const maxTokensRaw = config.maxTokens;
  if (maxTokensRaw !== undefined) {
    const n =
      typeof maxTokensRaw === "number"
        ? maxTokensRaw
        : typeof maxTokensRaw === "string"
          ? Number(maxTokensRaw)
          : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      checks.push({
        code: "anthropic_api_max_tokens_invalid",
        level: "error",
        message:
          "config.maxTokens must be a positive number (Anthropic API requires max_tokens)",
      });
    }
  }

  const thinkingRaw = config.thinking;
  if (
    thinkingRaw !== undefined &&
    thinkingRaw !== null &&
    typeof thinkingRaw !== "object"
  ) {
    checks.push({
      code: "anthropic_api_thinking_invalid",
      level: "error",
      message:
        "config.thinking must be null, undefined, or an object like {type: 'adaptive'}",
    });
  }

  checks.push({
    code: "anthropic_api_key_runtime",
    level: "info",
    message:
      "API key is resolved at run time from Settings -> API Keys (family = 'anthropic', mode = 'api').",
    hint: "If runs fail with 'no_api_key', configure the Anthropic key in instance settings.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
