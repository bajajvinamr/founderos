#!/usr/bin/env node
/**
 * `founderos-runner` CLI entry. v0.1 supports a single command:
 *
 *   founderos-runner start    — load config from env, start the poll loop
 *   founderos-runner --version
 *   founderos-runner --help
 *
 * Future commands (deferred):
 *   founderos-runner login    — interactive token prompt → write to TOML
 *   founderos-runner status   — print the latest /api/runner/jobs ping
 */

import { loadConfig, RunnerConfigError } from "./config.js";
import { runRunnerLoop } from "./main.js";
import { RUNNER_VERSION } from "./version.js";

function printHelp(): void {
  console.log(`founderos-runner v${RUNNER_VERSION}

USAGE
  founderos-runner start

ENVIRONMENT
  FOUNDEROS_RUNNER_URL          Cloud base URL (https://founderos.fly.dev)
  FOUNDEROS_RUNNER_TOKEN        Bearer token (fos_<32 chars>)
  FOUNDEROS_CLAUDE_BIN          Path to claude CLI [claude]
  FOUNDEROS_RUNNER_TIMEOUT_SEC  Per-job timeout [600]
  FOUNDEROS_RUNNER_LOG_LEVEL    debug | info | warn | error [info]

The runner reads jobs queued by the FounderOS cloud, spawns claude under
your local subscription, and streams results back. See ADR-011 for the
full architecture.`);
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

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      console.error(`config error: ${err.message}`);
      return 78; // EX_CONFIG
    }
    throw err;
  }

  await runRunnerLoop({ config });
  // process.exitCode is `string | number | undefined` in modern Node typings.
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

// Only auto-run when invoked directly. Testing imports `main()` and invokes it
// with explicit argv. We compare against process.argv[1] (the script path)
// resolved through fileURL to handle both `node dist/cli.js` and the npm bin
// shim transparently.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("fatal:", err);
      process.exit(1);
    },
  );
}
