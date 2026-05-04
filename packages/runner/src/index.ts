/**
 * Public API. Most consumers use the CLI; programmatic access is available
 * for embedded test harnesses or wrappers.
 */

export { loadConfig, RunnerConfigError, type RunnerConfig } from "./config.js";
export { RunnerApiClient, ApiError, type RunnerEvent, type JobPayload, type JobDescriptor } from "./api.js";
export { runClaude, parseStreamJsonLine, buildClaudeArgs } from "./spawn.js";
export { runRunnerLoop, consoleLogger, type RunnerLogger, type RunnerLoopOptions } from "./main.js";
export { RUNNER_VERSION } from "./version.js";
