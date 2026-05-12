import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@founderos/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@founderos/adapter-utils/server-utils";
import { execSync } from "node:child_process";
import path from "node:path";
import { models } from "../index.js";
import { parseCodexJsonl } from "./parse.js";
import { codexHomeDir, readCodexAuthInfo } from "./quota.js";
import { buildCodexExecArgs } from "./codex-args.js";

/**
 * Known Codex model allowlist, derived from the adapter's exported model
 * catalogue in `../index.ts`. Validation rejects any configured model id that
 * is not in this set so misconfigured installs surface a clear
 * `codex_unconfigured` reason instead of failing later at runtime with an
 * opaque "model not found" error from the CLI.
 */
const KNOWN_CODEX_MODEL_IDS: ReadonlySet<string> = new Set(models.map((m) => m.id));

/**
 * Env vars that gate Codex auth. Either the adapter's config env OR the host
 * process env must supply at least one of these (OR native `codex login`
 * credentials must be present, handled separately). Documented for the
 * structured `codex_missing_env` reason.
 */
const CODEX_AUTH_ENV_KEYS = ["OPENAI_API_KEY"] as const;

/**
 * Returns true when the given binary name is resolvable in the current PATH.
 * Uses `which` so it works correctly across platforms where PATH may differ
 * between the Node process and the user's shell. Any error (binary not found,
 * `which` not available) is treated as "not in PATH".
 *
 * Exposed for tests; production callers should prefer
 * `ensureCommandResolvable` which respects per-adapter cwd + env overrides.
 */
function isBinaryInPath(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const cwd = asString(config.cwd, process.cwd());

  // Honest-disable: if the CLI binary is not in PATH, return warn immediately.
  // On the hosted Fly server (no codex binary), this surfaces a clear message
  // pointing to the BYO runner instead of failing silently downstream with an
  // opaque "command not found" string buried in a probe stderr.
  if (!isBinaryInPath(command)) {
    checks.push({
      code: "codex_local_cli_not_found",
      level: "warn",
      message:
        "Codex CLI is not available on this server. Use 'Connect your own runner' to run Codex agents from your laptop.",
      detail: command,
      hint: "Install the Codex CLI on your local machine and connect a BYO runner at /settings/runner.",
    });
    return {
      adapterType: ctx.adapterType,
      status: "warn",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Honest-disable: validate the configured model id against the known
  // allowlist. An empty string or unknown id surfaces as `codex_unconfigured`
  // with a structured detail listing the accepted ids, so callers can fix the
  // config before invoking the CLI.
  const configuredModel = asString(config.model, "").trim();
  if (config.model !== undefined && config.model !== null) {
    if (!isNonEmpty(configuredModel)) {
      checks.push({
        code: "codex_unconfigured",
        level: "warn",
        message: "Codex model is configured but the value is empty.",
        detail: "Set adapter config `model` to one of the known Codex model ids.",
        hint: `Allowed ids: ${[...KNOWN_CODEX_MODEL_IDS].join(", ")}.`,
      });
      return {
        adapterType: ctx.adapterType,
        status: "warn",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
    if (!KNOWN_CODEX_MODEL_IDS.has(configuredModel)) {
      checks.push({
        code: "codex_unconfigured",
        level: "warn",
        message: `Codex model "${configuredModel}" is not in the known allowlist.`,
        detail: configuredModel,
        hint: `Allowed ids: ${[...KNOWN_CODEX_MODEL_IDS].join(", ")}.`,
      });
      return {
        adapterType: ctx.adapterType,
        status: "warn",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "codex_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configOpenAiKey = env.OPENAI_API_KEY;
  const hostOpenAiKey = process.env.OPENAI_API_KEY;
  if (isNonEmpty(configOpenAiKey) || isNonEmpty(hostOpenAiKey)) {
    const source = isNonEmpty(configOpenAiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    const codexHome = isNonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : undefined;
    const codexAuth = await readCodexAuthInfo(codexHome).catch(() => null);
    if (codexAuth) {
      checks.push({
        code: "codex_native_auth_present",
        level: "info",
        message: "Codex is authenticated via its own auth configuration.",
        detail: codexAuth.email ? `Logged in as ${codexAuth.email}.` : `Credentials found in ${path.join(codexHome ?? codexHomeDir(), "auth.json")}.`,
      });
    } else {
      // Structured `codex_missing_env` reason: list every documented auth key
      // that was checked, so operators see exactly which env var(s) to set
      // rather than guessing from the prose message.
      const missingKeys = CODEX_AUTH_ENV_KEYS.filter(
        (key) => !isNonEmpty(env[key]) && !isNonEmpty(process.env[key]),
      );
      checks.push({
        code: "codex_missing_env",
        level: "warn",
        message: `Codex auth env vars are not set: ${missingKeys.join(", ")}. Codex runs may fail until authentication is configured.`,
        detail: missingKeys.join(","),
        hint: `Set one of [${missingKeys.join(", ")}] in adapter env / shell environment, or run \`codex login\` to use native auth.`,
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "codex")) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `codex`.",
        detail: command,
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const execArgs = buildCodexExecArgs({ ...config, fastMode: false });
      const args = execArgs.args;
      if (execArgs.fastModeIgnoredReason) {
        checks.push({
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: execArgs.fastModeIgnoredReason,
          hint: "Switch the agent model to GPT-5.4 to enable Codex Fast mode.",
        });
      }

      const probe = await runChildProcess(
        `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );
      const parsed = parseCodexJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "codex_hello_probe_timed_out",
          level: "warn",
          message: "Codex hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Codex can run `Respond with hello` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Codex hello probe succeeded."
            : "Codex probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`codex exec --json -` then prompt: Respond with hello) to inspect full output.",
              }),
        });
      } else if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "codex_hello_probe_auth_required",
          level: "warn",
          message: "Codex CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Configure OPENAI_API_KEY in adapter env/shell or run `codex login`, then retry the probe.",
        });
      } else {
        checks.push({
          code: "codex_hello_probe_failed",
          level: "error",
          message: "Codex hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `codex exec --json -` manually in this working directory and prompt `Respond with hello` to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
