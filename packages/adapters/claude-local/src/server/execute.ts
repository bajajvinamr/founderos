import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@founderos/adapter-utils";
import type { RunProcessResult } from "@founderos/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildFounderOSEnv,
  readFounderOSRuntimeSkillEntries,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderFounderOSWakePrompt,
  stringifyFounderOSWakePayload,
  runChildProcess,
} from "@founderos/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { buildJobWorkdir, type JobWorkdir } from "./workdir.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hosted execution flag — when set, multi-tenant safety hardening kicks in:
 *   - per-job HOME / CLAUDE_CONFIG_DIR / CLAUDE_PROMPT_CACHE_DIR
 *   - explicit ANTHROPIC_API_KEY resolution from the per-instance vault
 *     (no fallback to inherited process.env)
 *   - --dangerously-skip-permissions defaults to false
 *   - workdir cleanup on every exit path
 *
 * Default off — local-dev path (single-tenant laptop runner) keeps the
 * legacy ergonomics including dangerouslySkipPermissions=true.
 */
function isHostedAgentsEnabled(): boolean {
  return process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED === "1";
}

/**
 * Resolver shape supplied via `config.apiKeyResolver` for hosted runs. Phase
 * 1B (PR #151 sibling) refactors `instance-api-keys.ts` to expose a
 * `getDecrypted(family, mode)` function with this signature; the server's
 * adapter registry wiring will set `config.apiKeyResolver` to the bound
 * function before dispatching execute(). Defining the type alias here means
 * this branch typechecks before Phase 1B lands; once both PRs merge the
 * server registry can pass the live resolver without further edits here.
 *
 * TODO(s8-p01-phase1b): when Phase 1B exposes `getDecrypted` on the server
 * service, swap to a direct typed import from a shared package boundary
 * (likely a small `@founderos/key-resolver` interface package, since the
 * adapter must not depend on `server/`).
 */
type AnthropicKeyResolver = (
  family: "anthropic",
  executionMode: "api",
) => Promise<string | null>;

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
  /**
   * Allocated only for hosted multi-tenant runs (FOUNDEROS_HOSTED_AGENTS_ENABLED=1).
   * Caller is responsible for cleaning up `workdir.root` after execute() returns.
   */
  workdir: JobWorkdir | null;
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;
  const hosted = isHostedAgentsEnabled();

  // Per-job workdir (C1 + C5 hardening). Allocated ONLY when hosted-agents
  // mode is on so single-tenant laptop runs keep their existing HOME and
  // session caches. The workdir's `cwd` is used as the spawn cwd only when
  // no workspace cwd is configured below.
  let workdir: JobWorkdir | null = null;
  if (hosted) {
    const companyIdValue = typeof agent.companyId === "string" ? agent.companyId.trim() : "";
    const safeCompanyId = companyIdValue.length > 0 ? companyIdValue : "unknown-company";
    const safeRunId = runId.trim().length > 0 ? runId.trim() : "unknown-run";
    const rootDirOverride = asString(config.workdirRoot, "").trim();
    workdir = await buildJobWorkdir({
      companyId: safeCompanyId,
      runId: safeRunId,
      ...(rootDirOverride.length > 0 ? { rootDir: rootDirOverride } : {}),
    });
  }

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.founderosWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.founderosWorkspaces)
    ? context.founderosWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.founderosRuntimeServiceIntents)
    ? context.founderosRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.founderosRuntimeServices)
    ? context.founderosRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.founderosRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  // Hosted runs: prefer the per-job workdir.cwd over process.cwd() so the
  // claude CLI's default file scope can't escape into the server's container
  // FS when no workspace cwd is configured.
  const fallbackCwd = workdir ? workdir.cwd : process.cwd();
  const cwd = effectiveWorkspaceCwd || configuredCwd || fallbackCwd;
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.FOUNDEROS_API_KEY === "string" && envConfig.FOUNDEROS_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildFounderOSEnv(agent) };
  env.FOUNDEROS_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyFounderOSWakePayload(context.founderosWake);

  if (wakeTaskId) {
    env.FOUNDEROS_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.FOUNDEROS_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.FOUNDEROS_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.FOUNDEROS_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.FOUNDEROS_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.FOUNDEROS_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.FOUNDEROS_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  if (effectiveWorkspaceCwd) {
    env.FOUNDEROS_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.FOUNDEROS_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.FOUNDEROS_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.FOUNDEROS_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.FOUNDEROS_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.FOUNDEROS_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.FOUNDEROS_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.FOUNDEROS_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.FOUNDEROS_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.FOUNDEROS_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.FOUNDEROS_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.FOUNDEROS_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.FOUNDEROS_API_KEY = authToken;
  }

  // Hosted multi-tenant overrides — applied AFTER envConfig so the user's
  // per-agent env block cannot accidentally re-leak the parent process's
  // shared HOME. These are the C1 isolation guarantees:
  //   HOME                     -> per-job dir; claude CLI session state
  //   CLAUDE_CONFIG_DIR        -> per-job ~/.claude; auth tokens, settings
  //   CLAUDE_PROMPT_CACHE_DIR  -> per-job prompt cache; cross-tenant cache
  //                               poisoning surface
  if (workdir) {
    env.HOME = workdir.home;
    env.CLAUDE_CONFIG_DIR = path.join(workdir.home, ".claude");
    env.CLAUDE_PROMPT_CACHE_DIR = workdir.cache;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROMPT_CACHE_DIR"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
    workdir,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  try {
    const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
      cwd: runtime.cwd,
      env: runtime.env,
      timeoutSec: runtime.timeoutSec,
      graceSec: runtime.graceSec,
      onLog,
    });

    const loginMeta = detectClaudeLoginRequired({
      parsed: null,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });

    return buildLoginResult({
      proc,
      loginUrl: loginMeta.loginUrl,
    });
  } finally {
    // C5 cleanup — best-effort; orphans handled by Phase 2A boot sweep.
    if (runtime.workdir) {
      await fs
        .rm(runtime.workdir.root, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your FounderOS work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  // C7 — hosted multi-tenant runs default to FALSE for permissions skip;
  // single-tenant local-dev runs preserve the legacy TRUE default. Explicit
  // `config.dangerouslySkipPermissions` always wins (e.g., a debugging
  // override) regardless of mode.
  const dangerouslySkipPermissions = asBoolean(
    config.dangerouslySkipPermissions,
    !isHostedAgentsEnabled(),
  );
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
    workdir,
  } = runtimeConfig;

  // C2 — hosted runs MUST resolve the Anthropic API key from the per-instance
  // vault (Phase 1B's getDecrypted). Caller wires the resolver via
  // `config.apiKeyResolver` at the registry layer. We never fall back to the
  // parent process.env because Phase 1B drops the global env-mutation surface.
  // Fail-fast with a structured error rather than spawning a doomed subprocess.
  if (workdir) {
    const apiKeyResolver = config.apiKeyResolver as AnthropicKeyResolver | undefined;
    let resolvedKey: string | null = null;
    if (typeof apiKeyResolver === "function") {
      try {
        resolvedKey = await apiKeyResolver("anthropic", "api");
      } catch {
        resolvedKey = null;
      }
    }
    if (!resolvedKey || resolvedKey.trim().length === 0) {
      // Best-effort cleanup — the workdir was created in buildClaudeRuntimeConfig
      // but no subprocess was spawned, so we discard it before the early return.
      await fs.rm(workdir.root, { recursive: true, force: true }).catch(() => {});
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "no_api_key",
        errorMessage: "Anthropic API key not configured for this instance",
      };
    }
    // Inject the decrypted value into the spawn env ONLY — never the parent
    // process.env. The override applies AFTER user envConfig so that buggy
    // per-agent config can't shadow it.
    env.ANTHROPIC_API_KEY = resolvedKey;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readFounderOSRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, claudeSkillEntries));
  // When instructionsFilePath is configured, build a stable content-addressed
  // file that includes both the file content and the path directive, so we only
  // need --append-system-prompt-file (Claude CLI forbids using both flags together).
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[founderos] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: claudeSkillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    instructionsContents: combinedInstructionsContents,
    onLog,
  });
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath ?? undefined;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    hasMatchingPromptBundle &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (
    runtimeSessionId &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(cwd)
  ) {
    await onLog(
      "stdout",
      `[founderos] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[founderos] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderFounderOSWakePrompt(context.founderosWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.founderosSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    args.push("--add-dir", promptBundle.addDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      );
    }
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command: resolvedCommand,
        cwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        promptBundleKey: promptBundle.bundleKey,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    // Council R1 Gemini P3 — claude's stream-json sometimes emits no
    // `result.cost_usd` field on errored runs; treat any access failure as
    // null instead of throwing or coercing undefined to 0.
    let costUsd: number | null = null;
    try {
      if (typeof parsedStream.costUsd === "number" && Number.isFinite(parsedStream.costUsd)) {
        costUsd = parsedStream.costUsd;
      } else {
        const fromTotal = asNumber(parsed.total_cost_usd, Number.NaN);
        costUsd = Number.isFinite(fromTotal) ? fromTotal : null;
      }
    } catch {
      costUsd = null;
    }

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd,
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // C5 — wrap the entire spawn lifecycle in try/finally so the per-job
  // workdir is always cleaned up on the way out, regardless of subprocess
  // exit status, errors during result parsing, or the resume-fallback retry
  // path. Best-effort: failures during cleanup are swallowed (orphans are
  // collected by Phase 2A's boot-time sweep).
  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stdout",
        `[founderos] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    if (workdir) {
      await fs.rm(workdir.root, { recursive: true, force: true }).catch(() => {});
    }
  }
}
