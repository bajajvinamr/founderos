/**
 * Interface-validation test for `src/handlers/types.ts` — the keystone
 * redesign from S7.1.b.2. This file's job is NOT to exercise behavior
 * (no spawning, no fetching, no stream parsing). Its job is to prove the
 * interface is *implementable* for every adapter family the runner needs
 * to support over the next two quarters.
 *
 * If any of the five mocks below fails to compile, the interface in
 * `types.ts` is structurally wrong — that's the council BLOCK signal:
 * an adapter family cannot satisfy the contract without contortions.
 *
 * Five mocks pinned here, one per planned adapter family:
 *   1. `mockClaudeLocal`    — SubprocessAdapter, stdin prompt, claude exit codes
 *   2. `mockGeminiLocal`    — SubprocessAdapter, async fs probe in environmentChecks
 *      (the council Gemini P2 — `~/.gemini/skills/` symlink + GEMINI_CLI_TRUST_WORKSPACE)
 *   3. `mockCodexLocal`     — SubprocessAdapter, codex exit codes
 *   4. `mockOpenaiApi`      — ApiAdapter, HTTP 429 retry-after, no buildArgs
 *   5. `mockGoogleApi`      — ApiAdapter, Google's quota-exhausted shape
 *
 * Each mock is annotated as the concrete sub-interface (`SubprocessAdapter`
 * or `ApiAdapter`) — TypeScript will refuse compile if any required field
 * is missing or any field's type is wrong. The runtime `expect`s at the
 * bottom are smoke-only (does the literal value match its `type` field?);
 * the real assertion is that this file typechecks at all.
 */

import { describe, it, expect } from "vitest";

import { stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { RunnerEvent } from "../../api.js";
import type {
  AdapterFailure,
  AnyAdapter,
  ApiAdapter,
  BuildArgsContext,
  EnvironmentCheckResult,
  EnvironmentContext,
  InterpretedFailure,
  RunContext,
  RunResult,
  SubprocessAdapter,
} from "../../handlers/types.js";

// ---------------------------------------------------------------------------
// Mock 1: claude_local — SubprocessAdapter
// ---------------------------------------------------------------------------

const mockClaudeLocal: SubprocessAdapter = {
  type: "claude_local",
  transport: "subprocess",
  defaultBinary: "claude",

  async environmentChecks(_ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const argv = ["--print", "-", "--output-format", "stream-json"];
    if (ctx.sessionId) argv.push("--resume", ctx.sessionId);
    if (ctx.instructionsFilePath) argv.push("--append-system-prompt-file", ctx.instructionsFilePath);
    return argv;
  },

  async promptTransport(child, prompt) {
    if (!child.stdin) throw new Error("no stdin");
    child.stdin.write(prompt);
    child.stdin.end();
  },

  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    return {
      status: "completed",
      elapsedSec: 0,
      exitCode: 0,
      sessionId: null,
      costUsd: 0,
    };
  },

  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    if (failure.signal === "SIGKILL" || failure.exitCode === 137) {
      return { errorCode: "timeout", retryable: true, humanMessage: "claude killed by hard timeout" };
    }
    return { errorCode: "unknown", retryable: false, humanMessage: "claude exited non-zero" };
  },
};

// ---------------------------------------------------------------------------
// Mock 2: gemini_local — SubprocessAdapter, async fs probe in environmentChecks
//
// The council Gemini P2 finding: gemini_local needs a real async probe
// (stat ~/.gemini/skills/, GEMINI_CLI_TRUST_WORKSPACE check). The prior
// interface forced this into a separate ad-hoc code path; the redesign
// puts it directly on `environmentChecks`.
// ---------------------------------------------------------------------------

const mockGeminiLocal: SubprocessAdapter = {
  type: "gemini_local",
  transport: "subprocess",
  defaultBinary: "gemini",

  async environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    // (1) Trust-workspace env var must be set or gemini exits 55.
    if (ctx.env["GEMINI_CLI_TRUST_WORKSPACE"] !== "true") {
      return {
        ok: false,
        reason: "GEMINI_CLI_TRUST_WORKSPACE not set",
        remediation: "Run `export GEMINI_CLI_TRUST_WORKSPACE=true` before launching the runner.",
      };
    }
    // (2) Skills dir must exist (read-only fs probe — exactly the use
    //     case the prior "must be pure" rule blocked).
    const skillsDir = path.join(os.homedir(), ".gemini", "skills");
    try {
      const s = await stat(skillsDir);
      if (!s.isDirectory()) {
        return {
          ok: false,
          reason: `${skillsDir} exists but is not a directory`,
          remediation: "Remove the file and re-init gemini.",
        };
      }
    } catch {
      // Missing skills dir is non-fatal for gemini_local; warn-via-event
      // would be a separate signal. Treat as ok for now.
    }
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const argv = ["--json"];
    if (ctx.sessionId) argv.push("--resume-session", ctx.sessionId);
    return argv;
  },

  async promptTransport(child, prompt) {
    if (!child.stdin) throw new Error("no stdin");
    child.stdin.write(prompt);
    child.stdin.end();
  },

  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    return {
      status: "completed",
      elapsedSec: 0,
      exitCode: 0,
    };
  },

  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    // gemini-specific: exit 55 = workspace not trusted (council R1 finding).
    if (failure.exitCode === 55) {
      return {
        errorCode: "workspace_not_trusted",
        retryable: false,
        humanMessage:
          "gemini exited 55 — workspace not trusted. Set GEMINI_CLI_TRUST_WORKSPACE=true and rerun.",
      };
    }
    if (failure.signal === "SIGKILL") {
      return { errorCode: "timeout", retryable: true, humanMessage: "gemini hard timeout" };
    }
    return { errorCode: "unknown", retryable: false, humanMessage: `gemini exit ${failure.exitCode ?? "?"}` };
  },
};

// ---------------------------------------------------------------------------
// Mock 3: codex_local — SubprocessAdapter
// ---------------------------------------------------------------------------

const mockCodexLocal: SubprocessAdapter = {
  type: "codex_local",
  transport: "subprocess",
  defaultBinary: "codex",

  async environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    if (!ctx.env["OPENAI_API_KEY"] && !ctx.env["CODEX_AUTH"]) {
      return {
        ok: false,
        reason: "Codex CLI requires OPENAI_API_KEY or CODEX_AUTH",
        remediation: "Set OPENAI_API_KEY in the runner env or company secrets.",
      };
    }
    return { ok: true };
  },

  buildArgs(ctx: BuildArgsContext): string[] {
    const argv = ["exec", "--stream"];
    if (ctx.workdir) argv.push("--cwd", ctx.workdir);
    return argv;
  },

  async promptTransport(child, prompt) {
    if (!child.stdin) throw new Error("no stdin");
    child.stdin.write(prompt);
    child.stdin.end();
  },

  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    return {
      status: "completed",
      elapsedSec: 0,
      exitCode: 0,
    };
  },

  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    // codex CLI optional-arg parse failure (the invariant in
    // ~/.claude/rules/vinamr-invariants.staging.md): exits 2 on
    // unexpected `-a` / `-s`.
    if (failure.exitCode === 2) {
      return {
        errorCode: "bad_request",
        retryable: false,
        humanMessage: "codex CLI rejected the argv (exit 2). Check buildArgs output for unexpected flags.",
      };
    }
    if (failure.signal === "SIGKILL") {
      return { errorCode: "timeout", retryable: true, humanMessage: "codex hard timeout" };
    }
    return { errorCode: "unknown", retryable: false, humanMessage: `codex exit ${failure.exitCode ?? "?"}` };
  },
};

// ---------------------------------------------------------------------------
// Mock 4: openai_api — ApiAdapter
//
// Pure-HTTP path. No buildArgs, no promptTransport — `run()` owns the
// whole HTTP cycle. Failure interpretation reads HTTP status + Retry-After
// rather than exit code.
// ---------------------------------------------------------------------------

const mockOpenaiApi: ApiAdapter = {
  type: "openai_api",
  transport: "api",
  defaultEndpoint: "https://api.openai.com/v1/responses",

  async environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    if (!ctx.env["OPENAI_API_KEY"]) {
      return {
        ok: false,
        reason: "OPENAI_API_KEY missing",
        remediation: "Set OPENAI_API_KEY in the runner env or company secrets.",
      };
    }
    return { ok: true };
  },

  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    // Real impl would fetch + parse SSE; mock returns success for compilation.
    return {
      status: "completed",
      elapsedSec: 0,
      httpStatus: 200,
      costUsd: 0,
    };
  },

  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    const status = failure.httpStatus;
    if (status === 429) {
      // Honor Retry-After header — Codex P2 finding: machine-readable retry.
      const retryAfter = failure.responseHeaders?.["retry-after"];
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
      return {
        errorCode: "rate_limit",
        retryable: true,
        retryAfterMs,
        humanMessage: `OpenAI 429 rate limit; retry after ${Math.round(retryAfterMs / 1000)}s.`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        errorCode: "auth_failed",
        retryable: false,
        humanMessage: `OpenAI ${status} — credentials missing or invalid.`,
      };
    }
    if (status === 503) {
      return {
        errorCode: "provider_overloaded",
        retryable: true,
        retryAfterMs: 30_000,
        humanMessage: "OpenAI 503 — provider overloaded.",
      };
    }
    if (failure.error?.name === "AbortError") {
      return { errorCode: "cancelled", retryable: false, humanMessage: "OpenAI request aborted." };
    }
    return {
      errorCode: "unknown",
      retryable: typeof status === "number" && status >= 500,
      humanMessage: `OpenAI failure: status=${status ?? "?"}, err=${failure.error?.message ?? "?"}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Mock 5: google_api — ApiAdapter
//
// Google's quota-exhausted error returns 429 with an upstream-specific
// body shape (we ignore the body in the mock; real adapter would parse it).
// ---------------------------------------------------------------------------

const mockGoogleApi: ApiAdapter = {
  type: "openclaw_gateway", // No `google_api` enum value yet (ticket S7.0.1 added enum entries; google_api lands later). Use the existing closest enum literal.
  transport: "api",
  defaultEndpoint:
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent",

  async environmentChecks(ctx: EnvironmentContext): Promise<EnvironmentCheckResult> {
    if (!ctx.env["GOOGLE_API_KEY"] && !ctx.env["GEMINI_API_KEY"]) {
      return {
        ok: false,
        reason: "GOOGLE_API_KEY or GEMINI_API_KEY missing",
        remediation: "Set GOOGLE_API_KEY in the runner env or company secrets.",
      };
    }
    return { ok: true };
  },

  // eslint-disable-next-line require-yield
  async *run(_ctx: RunContext, _signal: AbortSignal): AsyncGenerator<RunnerEvent, RunResult, void> {
    return {
      status: "completed",
      elapsedSec: 0,
      httpStatus: 200,
    };
  },

  interpretFailure(failure: AdapterFailure): InterpretedFailure {
    const status = failure.httpStatus;
    // Google distinguishes RESOURCE_EXHAUSTED in the body even on 429.
    if (status === 429) {
      const body = failure.responseBody as { error?: { status?: string } } | undefined;
      const isQuota = body?.error?.status === "RESOURCE_EXHAUSTED";
      return {
        errorCode: isQuota ? "rate_limit" : "rate_limit",
        retryable: true,
        retryAfterMs: 60_000,
        humanMessage: isQuota
          ? "Gemini quota exhausted. Free tier has a daily cap; try again tomorrow or upgrade."
          : "Gemini 429 rate limit.",
      };
    }
    if (status === 401 || status === 403) {
      return {
        errorCode: "auth_failed",
        retryable: false,
        humanMessage: `Gemini ${status} — credentials missing or invalid.`,
      };
    }
    if (failure.error?.name === "AbortError") {
      return { errorCode: "cancelled", retryable: false, humanMessage: "Gemini request aborted." };
    }
    return {
      errorCode: "unknown",
      retryable: typeof status === "number" && status >= 500,
      humanMessage: `Gemini failure: status=${status ?? "?"}, err=${failure.error?.message ?? "?"}`,
    };
  },
};

// ---------------------------------------------------------------------------
// The five mocks must form a valid `AnyAdapter` array — proves
// `SubprocessAdapter | ApiAdapter` discrimination works as expected.
// ---------------------------------------------------------------------------

const ALL_MOCKS: readonly AnyAdapter[] = [
  mockClaudeLocal,
  mockGeminiLocal,
  mockCodexLocal,
  mockOpenaiApi,
  mockGoogleApi,
] as const;

describe("AdapterHandler interface — implementability proof (S7.1.b.2)", () => {
  it("compiles all five planned adapter mocks against SubprocessAdapter | ApiAdapter", () => {
    // The real assertion is that this file typechecks. The runtime
    // checks below are smoke — does each mock identify with its
    // declared transport?
    expect(ALL_MOCKS).toHaveLength(5);
    expect(mockClaudeLocal.transport).toBe("subprocess");
    expect(mockGeminiLocal.transport).toBe("subprocess");
    expect(mockCodexLocal.transport).toBe("subprocess");
    expect(mockOpenaiApi.transport).toBe("api");
    expect(mockGoogleApi.transport).toBe("api");
  });

  it("subprocess mocks expose buildArgs + promptTransport; api mocks do not", () => {
    // Type narrowing via the `transport` discriminant is the dispatcher's
    // mechanism for branching. Verify it works at runtime.
    for (const a of ALL_MOCKS) {
      if (a.transport === "subprocess") {
        expect(typeof a.buildArgs).toBe("function");
        expect(typeof a.promptTransport).toBe("function");
        expect(typeof a.defaultBinary).toBe("string");
      } else {
        expect(typeof a.defaultEndpoint).toBe("string");
        // @ts-expect-error — ApiAdapter has no buildArgs by design.
        expect(a.buildArgs).toBeUndefined();
        // @ts-expect-error — ApiAdapter has no promptTransport by design.
        expect(a.promptTransport).toBeUndefined();
      }
    }
  });

  it("environmentChecks returns EnvironmentCheckResult for every adapter", async () => {
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true", OPENAI_API_KEY: "sk-test", GOOGLE_API_KEY: "g-test" };
    for (const a of ALL_MOCKS) {
      const result = await a.environmentChecks({ env });
      expect(typeof result.ok).toBe("boolean");
    }
  });

  it("interpretFailure returns machine-readable retry semantics for every adapter", () => {
    // 429 across both API mocks should produce retryable rate_limit.
    const openaiRl = mockOpenaiApi.interpretFailure({ httpStatus: 429, responseHeaders: { "retry-after": "30" } });
    expect(openaiRl.errorCode).toBe("rate_limit");
    expect(openaiRl.retryable).toBe(true);
    expect(openaiRl.retryAfterMs).toBe(30_000);

    const googleRl = mockGoogleApi.interpretFailure({
      httpStatus: 429,
      responseBody: { error: { status: "RESOURCE_EXHAUSTED" } },
    });
    expect(googleRl.errorCode).toBe("rate_limit");
    expect(googleRl.retryable).toBe(true);

    // Subprocess timeout shape.
    const claudeTimeout = mockClaudeLocal.interpretFailure({ signal: "SIGKILL" });
    expect(claudeTimeout.errorCode).toBe("timeout");
    expect(claudeTimeout.retryable).toBe(true);

    // Gemini-specific exit-55 trust-workspace path.
    const geminiTrust = mockGeminiLocal.interpretFailure({ exitCode: 55 });
    expect(geminiTrust.errorCode).toBe("workspace_not_trusted");
    expect(geminiTrust.retryable).toBe(false);

    // Codex-specific exit-2 argv-parse.
    const codexBadArgs = mockCodexLocal.interpretFailure({ exitCode: 2 });
    expect(codexBadArgs.errorCode).toBe("bad_request");
    expect(codexBadArgs.retryable).toBe(false);
  });
});
