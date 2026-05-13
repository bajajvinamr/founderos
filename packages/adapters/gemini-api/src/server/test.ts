import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@founderos/adapter-utils";
import { parseObject } from "@founderos/adapter-utils/server-utils";
import { DEFAULT_GEMINI_API_MODEL, models } from "../index.js";

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
      code: "gemini_api_model_default",
      level: "info",
      message: `Using default model: ${DEFAULT_GEMINI_API_MODEL}`,
    });
  } else if (typeof modelRaw !== "string") {
    checks.push({
      code: "gemini_api_model_invalid",
      level: "error",
      message: "config.model must be a string",
    });
  } else {
    const known = models.some((m) => m.id === modelRaw);
    checks.push({
      code: known ? "gemini_api_model_configured" : "gemini_api_model_custom",
      level: known ? "info" : "warn",
      message: known
        ? `Configured model: ${modelRaw}`
        : `Custom model id not in the known list: ${modelRaw}`,
      hint: known
        ? undefined
        : "Google may reject unknown model ids at run time. Verify the model is enabled on your Google Cloud project.",
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
        code: "gemini_api_timeout_invalid",
        level: "error",
        message: "config.timeoutSec must be a positive number",
      });
    }
  }

  checks.push({
    code: "gemini_api_key_runtime",
    level: "info",
    message:
      "API key is resolved at run time from Settings → API Keys (family = 'google').",
    hint: "If runs fail with 'no_api_key', configure the Google key in instance settings.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
