#!/usr/bin/env node
/**
 * `founderos-runner` CLI entry. Supports a single command:
 *
 *   founderos-runner start [--token=...] [--server-url=...] [--claude-bin=...]
 *                          [--timeout-sec=N] [--log-level=info]
 *   founderos-runner --version
 *   founderos-runner --help
 *
 * Flags override the matching FOUNDEROS_* environment variables. Both
 * forms are supported because Windows PowerShell users find env-var
 * setup awkward (`$env:FOUNDEROS_RUNNER_TOKEN="..."` vs `--token=...`),
 * and macOS/Linux users in shell scripts often prefer env vars.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig, RunnerConfigError, type RunnerConfigOverrides } from "./config.js";
import { runRunnerLoop } from "./main.js";
import { RUNNER_VERSION } from "./version.js";

function printHelp(): void {
  console.log(`founderos-runner v${RUNNER_VERSION}

USAGE
  founderos-runner start [flags]
  founderos-runner --version
  founderos-runner --help

FLAGS
  --token=<fos_...>           Runner token (overrides FOUNDEROS_RUNNER_TOKEN)
  --server-url=<url>          Cloud base URL (overrides FOUNDEROS_RUNNER_URL)
  --claude-bin=<path>         Path to claude CLI (overrides FOUNDEROS_CLAUDE_BIN)
  --timeout-sec=<n>           Per-job timeout 1..3600 (overrides FOUNDEROS_RUNNER_TIMEOUT_SEC)
  --log-level=<level>         debug | info | warn | error (overrides FOUNDEROS_RUNNER_LOG_LEVEL)

ENVIRONMENT (used when matching flag is omitted)
  FOUNDEROS_RUNNER_URL          Cloud base URL (https://founderos.fly.dev)
  FOUNDEROS_RUNNER_TOKEN        Bearer token (fos_<32 chars>)
  FOUNDEROS_CLAUDE_BIN          Path to claude CLI [claude]
  FOUNDEROS_RUNNER_TIMEOUT_SEC  Per-job timeout [600]
  FOUNDEROS_RUNNER_LOG_LEVEL    debug | info | warn | error [info]

EXAMPLES
  # Flags (recommended on Windows PowerShell)
  npx @founderos/runner start --token=fos_xxx --server-url=https://founderos.fly.dev

  # macOS/Linux — env vars
  export FOUNDEROS_RUNNER_TOKEN=fos_xxx
  export FOUNDEROS_RUNNER_URL=https://founderos.fly.dev
  founderos-runner start

The runner reads jobs queued by the FounderOS cloud, spawns claude under
your local subscription, and streams results back. See ADR-011 for the
full architecture.`);
}

/**
 * Parse `--key=value` and `--key value` flag forms. Returns parsed
 * overrides + any unknown args (which we treat as errors today).
 *
 * Argv shape: caller has already stripped node + script + the "start"
 * subcommand. Only flag tokens remain.
 */
export function parseFlags(argv: string[]): {
  overrides: RunnerConfigOverrides;
  unknown: string[];
} {
  const overrides: RunnerConfigOverrides = {};
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      unknown.push(tok);
      continue;
    }
    const eqIdx = tok.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eqIdx >= 0) {
      key = tok.slice(2, eqIdx);
      value = tok.slice(eqIdx + 1);
    } else {
      key = tok.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }

    if (value == null || value === "") {
      unknown.push(tok);
      continue;
    }

    switch (key) {
      case "token":
        overrides.token = value;
        break;
      case "server-url":
        overrides.serverUrl = value;
        break;
      case "claude-bin":
        overrides.claudeBin = value;
        break;
      case "timeout-sec": {
        const n = Number(value);
        if (Number.isFinite(n)) overrides.defaultTimeoutSec = n;
        else unknown.push(tok);
        break;
      }
      case "log-level":
        overrides.logLevel = value;
        break;
      default:
        unknown.push(tok);
    }
  }

  return { overrides, unknown };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] ?? "start";

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(RUNNER_VERSION);
    return 0;
  }
  if (cmd !== "start") {
    console.error(`unknown command: ${cmd}`);
    printHelp();
    return 64;
  }

  const { overrides, unknown } = parseFlags(argv.slice(1));
  if (unknown.length > 0) {
    console.error(`unknown or malformed flag(s): ${unknown.join(" ")}`);
    printHelp();
    return 64;
  }

  let config;
  try {
    config = loadConfig(process.env, overrides);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      console.error(`config error: ${err.message}`);
      return 78; // EX_CONFIG
    }
    throw err;
  }

  await runRunnerLoop({ config });
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

/**
 * Detect whether this module is being invoked directly (i.e. via the
 * `bin` shim or `node dist/cli.js`) versus imported by tests.
 *
 * Naive equality `import.meta.url === \`file://\${process.argv[1]}\`` breaks
 * under npm bin shims: argv[1] is the symlink path
 * (`node_modules/.bin/founderos-runner`, no `.js` extension), while
 * `import.meta.url` resolves to the symlink target. They never match.
 * The fix: resolve argv[1] through `realpathSync` and compare against
 * the URL converted to a filesystem path. Both sides end up as the
 * same canonical path. Wrapped in try/catch because argv[1] can be
 * undefined or non-existent in unusual harnesses.
 */
function isDirectInvocation(): boolean {
  try {
    const invokedPath = process.argv[1];
    if (!invokedPath) return false;
    return realpathSync(invokedPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("fatal:", err);
      process.exit(1);
    },
  );
}
