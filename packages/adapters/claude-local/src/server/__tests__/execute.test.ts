/**
 * Multi-tenant safety hardening tests for the server-side claude handler
 * (S8 P0.1 Phase 1C — council R1 conditions C1, C5, C7, C8).
 *
 * Covers:
 *  - buildJobWorkdir creates the per-job directory tree with mode 0700
 *  - execute() returns errorCode 'no_api_key' WITHOUT spawning when no key
 *  - execute() injects the resolved key into the spawn env (parent process.env
 *    is never read for ANTHROPIC_API_KEY)
 *  - execute() env override beats the parent process's HOME
 *  - execute() cleans up the workdir on success and on failure
 *  - cost_usd extraction returns null when claude emits no result.cost_usd
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "../execute.js";
import { buildJobWorkdir } from "../workdir.js";

type Capture = {
  argv: string[];
  prompt: string;
  env: Record<string, string>;
  cwd: string;
};

async function writeFakeClaudeCommand(
  commandPath: string,
  options: { emitCostUsd?: boolean; failExit?: boolean } = {},
): Promise<void> {
  const emitCostUsd = options.emitCostUsd !== false; // default true
  const failExit = options.failExit === true;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
const capturePath = process.env.FOUNDEROS_TEST_CAPTURE_PATH;
const payload = {
  argv,
  prompt: fs.readFileSync(0, "utf8"),
  env: {
    HOME: process.env.HOME || "",
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || "",
    CLAUDE_PROMPT_CACHE_DIR: process.env.CLAUDE_PROMPT_CACHE_DIR || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  },
  cwd: process.cwd(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-test", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-test", message: { content: [{ type: "text", text: "ok" }] } }));
const result = { type: "result", session_id: "claude-session-test", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } };
${emitCostUsd ? "result.total_cost_usd = 0.0125;" : ""}
console.log(JSON.stringify(result));
process.exit(${failExit ? 7 : 0});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

interface HarnessOptions {
  emitCostUsd?: boolean;
  failExit?: boolean;
}

interface Harness {
  root: string;
  workspace: string;
  binDir: string;
  commandPath: string;
  capturePath: string;
  workdirRoot: string;
  cleanup: () => Promise<void>;
}

async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-claude-p01-"));
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const workdirRoot = path.join(root, "agent-workdirs");
  const commandPath = path.join(binDir, "claude");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(workdirRoot, { recursive: true });
  await writeFakeClaudeCommand(commandPath, opts);
  return {
    root,
    workspace,
    binDir,
    commandPath,
    capturePath,
    workdirRoot,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const ENV_KEYS = [
  "FOUNDEROS_HOSTED_AGENTS_ENABLED",
  "HOME",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROMPT_CACHE_DIR",
  "PATH",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
});

describe("buildJobWorkdir", () => {
  it("creates home, cache, and cwd subdirs each with mode 0700", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-workdir-"));
    try {
      const wd = await buildJobWorkdir({
        companyId: "co1",
        runId: "r1",
        rootDir: root,
      });
      expect(wd.root).toBe(path.join(root, "co1", "r1"));
      expect(wd.home).toBe(path.join(wd.root, "home"));
      expect(wd.cache).toBe(path.join(wd.root, "cache"));
      expect(wd.cwd).toBe(path.join(wd.root, "cwd"));
      const homeStat = await fs.stat(wd.home);
      const cacheStat = await fs.stat(wd.cache);
      const cwdStat = await fs.stat(wd.cwd);
      // Mask the perm bits (lower 9) — type bits live higher up.
      expect(homeStat.mode & 0o777).toBe(0o700);
      expect(cacheStat.mode & 0o777).toBe(0o700);
      expect(cwdStat.mode & 0o777).toBe(0o700);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("execute() — multi-tenant hardening (FOUNDEROS_HOSTED_AGENTS_ENABLED=1)", () => {
  it("returns no_api_key error WITHOUT spawning when no resolver is wired", async () => {
    const h = await createHarness();
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    // Sanity: no parent-env API key fallback for hosted runs.
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await execute({
        runId: "run-no-key",
        agent: { id: "agent-1", companyId: "co-isolated", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Should never spawn.",
          // No apiKeyResolver supplied.
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBeNull();
      expect(result.errorCode).toBe("no_api_key");
      expect(result.errorMessage).toContain("Anthropic API key");
      // Capture file MUST NOT have been written — proves the subprocess
      // never ran.
      let captureWritten = false;
      try {
        await fs.access(h.capturePath);
        captureWritten = true;
      } catch {
        captureWritten = false;
      }
      expect(captureWritten).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("returns no_api_key when the resolver returns null (no spawn)", async () => {
    const h = await createHarness();
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    let resolverCalled = 0;
    try {
      const result = await execute({
        runId: "run-null-key",
        agent: { id: "agent-1", companyId: "co-isolated", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Should never spawn.",
          apiKeyResolver: async () => {
            resolverCalled++;
            return null;
          },
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.errorCode).toBe("no_api_key");
      expect(resolverCalled).toBe(1);
      // The per-run workdir MUST be cleaned up even on the early return.
      // (The companyId parent dir may linger; that's fine — Phase 2A's
      // boot sweep collects empty parents on a stale-mtime cadence.)
      const runDir = path.join(h.workdirRoot, "co-isolated", "run-null-key");
      let runDirExists = true;
      try {
        await fs.stat(runDir);
      } catch (err) {
        runDirExists = false;
        const code = (err as NodeJS.ErrnoException).code;
        expect(code).toBe("ENOENT");
      }
      expect(runDirExists).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("spawns the child with ANTHROPIC_API_KEY in env when the resolver returns a key", async () => {
    const h = await createHarness();
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await execute({
        runId: "run-with-key",
        agent: { id: "agent-1", companyId: "co-spawn", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          apiKeyResolver: async () => "sk-ant-test-key-xyz",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeNull();
      const captured = JSON.parse(await fs.readFile(h.capturePath, "utf-8")) as Capture;
      expect(captured.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key-xyz");
    } finally {
      await h.cleanup();
    }
  });

  it("spawn env HOME points to the per-job workdir, NOT the parent HOME", async () => {
    const h = await createHarness();
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    // Parent HOME is the harness tmpdir (must be writable so prompt-cache
    // helpers can populate the FounderOS-managed cache). The spawn HOME must
    // resolve to a DIFFERENT path inside the per-job workdir tree.
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_PROMPT_CACHE_DIR;
    try {
      const result = await execute({
        runId: "run-home-isolation",
        agent: { id: "agent-1", companyId: "co-iso", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          apiKeyResolver: async () => "sk-ant-test",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(await fs.readFile(h.capturePath, "utf-8")) as Capture;
      // HOME must point INSIDE the per-job workdir, not the parent harness root.
      expect(captured.env.HOME).not.toBe(h.root);
      expect(captured.env.HOME.startsWith(h.workdirRoot)).toBe(true);
      expect(captured.env.HOME.endsWith(path.join("co-iso", "run-home-isolation", "home"))).toBe(true);
      // CLAUDE_CONFIG_DIR is HOME/.claude.
      expect(captured.env.CLAUDE_CONFIG_DIR).toBe(path.join(captured.env.HOME, ".claude"));
      // CLAUDE_PROMPT_CACHE_DIR is the per-job cache subdir.
      expect(captured.env.CLAUDE_PROMPT_CACHE_DIR.endsWith(path.join("co-iso", "run-home-isolation", "cache"))).toBe(
        true,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("cleans up the workdir on success", async () => {
    const h = await createHarness();
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    try {
      await execute({
        runId: "run-cleanup-success",
        agent: { id: "agent-1", companyId: "co-cleanup", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          apiKeyResolver: async () => "sk-ant-test",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const expected = path.join(h.workdirRoot, "co-cleanup", "run-cleanup-success");
      let exists = true;
      try {
        await fs.stat(expected);
      } catch (err) {
        exists = false;
        const code = (err as NodeJS.ErrnoException).code;
        expect(code).toBe("ENOENT");
      }
      expect(exists).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("cleans up the workdir on subprocess error (non-zero exit)", async () => {
    const h = await createHarness({ failExit: true });
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    try {
      const result = await execute({
        runId: "run-cleanup-failure",
        agent: { id: "agent-1", companyId: "co-cleanup-f", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          apiKeyResolver: async () => "sk-ant-test",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(7);
      const expected = path.join(h.workdirRoot, "co-cleanup-f", "run-cleanup-failure");
      let exists = true;
      try {
        await fs.stat(expected);
      } catch (err) {
        exists = false;
        const code = (err as NodeJS.ErrnoException).code;
        expect(code).toBe("ENOENT");
      }
      expect(exists).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("returns costUsd=null when claude emits no result.cost_usd / total_cost_usd field", async () => {
    const h = await createHarness({ emitCostUsd: false });
    process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED = "1";
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    try {
      const result = await execute({
        runId: "run-no-cost",
        agent: { id: "agent-1", companyId: "co-cost", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          apiKeyResolver: async () => "sk-ant-test",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.costUsd).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});

describe("execute() — local-dev path (FOUNDEROS_HOSTED_AGENTS_ENABLED unset)", () => {
  it("does NOT allocate a per-job workdir or block on missing key", async () => {
    const h = await createHarness();
    delete process.env.FOUNDEROS_HOSTED_AGENTS_ENABLED;
    process.env.HOME = h.root;
    process.env.PATH = `${h.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    try {
      const result = await execute({
        runId: "run-local",
        agent: { id: "agent-1", companyId: "co-local", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: h.commandPath,
          cwd: h.workspace,
          workdirRoot: h.workdirRoot,
          env: { FOUNDEROS_TEST_CAPTURE_PATH: h.capturePath },
          promptTemplate: "Hello.",
          // No apiKeyResolver supplied — and that's fine for local dev.
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeNull();
      // The workdir root must still be empty — we never allocated under it.
      const children = await fs.readdir(h.workdirRoot).catch(() => []);
      expect(children).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
