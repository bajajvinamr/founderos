/**
 * Environment-check rigor tests for codex-local (L2-A02).
 *
 * Covers three structured "honest-disable" reasons:
 * - `codex_local_cli_not_found` — the codex binary is not in PATH
 * - `codex_unconfigured`        — config.model is set but empty or unknown
 * - `codex_missing_env`         — OPENAI_API_KEY (and native auth) absent
 *
 * Plus the happy path: when binary + env are both fine, the function
 * proceeds past the early-return guards without surfacing any
 * `codex_local_cli_not_found` / `codex_unconfigured` / `codex_missing_env`
 * check.
 *
 * Pattern: vi.mock("node:child_process") is hoisted before imports by
 * Vitest, so `execSync` is replaced before `testEnvironment` is called.
 * That lets us simulate "which codex" success/failure deterministically.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AdapterEnvironmentTestContext } from "@founderos/adapter-utils";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
//
// `binaryInPath` toggles whether the simulated `which <bin>` call succeeds.
// Set it inside each test (via `setBinaryInPath`) before calling
// `testEnvironment`.
//
// Note: vi.mock factories run at module load BEFORE imports, but the
// `execSync` returned by the factory closes over `binaryInPathRef` (a
// captured Map/object), so subsequent mutations are visible to the
// adapter under test.
// ---------------------------------------------------------------------------

const binaryInPathRef = { value: true };

function setBinaryInPath(value: boolean): void {
  binaryInPathRef.value = value;
}

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execSync: vi.fn((cmd: string) => {
      if (typeof cmd === "string" && cmd.startsWith("which ")) {
        if (!binaryInPathRef.value) {
          throw new Error("not found");
        }
        return Buffer.from("/usr/local/bin/codex\n");
      }
      // Fall through to a no-op buffer for any other execSync use.
      return Buffer.from("");
    }),
  };
});

// Avoid the network/probe side effects from the full testEnvironment path
// in this unit suite by stubbing the codex auth + child-process probe modules.
vi.mock("../quota.js", () => ({
  codexHomeDir: () => "/tmp/codex-home",
  readCodexAuthInfo: vi.fn(async () => null),
}));

vi.mock("@founderos/adapter-utils/server-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@founderos/adapter-utils/server-utils")>();
  return {
    ...original,
    ensureAbsoluteDirectory: vi.fn(async () => undefined),
    ensureCommandResolvable: vi.fn(async () => undefined),
    runChildProcess: vi.fn(async () => ({
      runId: "stub",
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
      stdout: '{"type":"agent_message","message":"hello"}\n',
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })),
  };
});

// Import the system-under-test AFTER the mocks above.
const { testEnvironment } = await import("../test.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(config: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
  return {
    companyId: "test-company",
    adapterType: "codex_local",
    config,
  };
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  setBinaryInPath(true);
  // Strip any host OPENAI_API_KEY leaking from the dev shell so tests are
  // deterministic. Restored in afterEach.
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("testEnvironment — binary not in PATH", () => {
  it("returns warn with codex_local_cli_not_found and no further checks", async () => {
    setBinaryInPath(false);

    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("warn");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("codex_local_cli_not_found");
    expect(result.checks[0].level).toBe("warn");
    expect(result.checks[0].message).toMatch(/Codex CLI/);
    expect(result.checks[0].hint).toMatch(/\/settings\/runner/);
  });

  it("short-circuits before cwd / model / env validation", async () => {
    setBinaryInPath(false);

    const result = await testEnvironment(
      makeCtx({
        cwd: "/nonexistent/xyz",
        model: "definitely-not-a-real-model",
      }),
    );

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("codex_local_cli_not_found");
  });
});

describe("testEnvironment — model allowlist (codex_unconfigured)", () => {
  it("returns warn with codex_unconfigured when model is an empty string", async () => {
    const result = await testEnvironment(makeCtx({ model: "" }));

    expect(result.status).toBe("warn");
    const codes = result.checks.map((c) => c.code);
    expect(codes).toContain("codex_unconfigured");
    const check = result.checks.find((c) => c.code === "codex_unconfigured");
    expect(check?.level).toBe("warn");
    expect(check?.hint).toMatch(/Allowed ids:/);
  });

  it("returns warn with codex_unconfigured when model is unknown", async () => {
    const result = await testEnvironment(makeCtx({ model: "not-a-real-model" }));

    expect(result.status).toBe("warn");
    const check = result.checks.find((c) => c.code === "codex_unconfigured");
    expect(check).toBeDefined();
    expect(check?.message).toContain("not-a-real-model");
    expect(check?.detail).toBe("not-a-real-model");
  });

  it("does NOT emit codex_unconfigured when model is omitted (defaults)", async () => {
    // OPENAI_API_KEY supplied so the env-missing reason is not raised either.
    process.env.OPENAI_API_KEY = "sk-test-fixture";

    const result = await testEnvironment(makeCtx());

    const codes = result.checks.map((c) => c.code);
    expect(codes).not.toContain("codex_unconfigured");
    expect(codes).not.toContain("codex_missing_env");
  });

  it("accepts a known model id from the public allowlist", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fixture";

    const result = await testEnvironment(makeCtx({ model: "gpt-5.4" }));

    const codes = result.checks.map((c) => c.code);
    expect(codes).not.toContain("codex_unconfigured");
  });
});

describe("testEnvironment — missing env (codex_missing_env)", () => {
  it("returns warn with codex_missing_env listing OPENAI_API_KEY when absent", async () => {
    // Native auth mock already returns null, so neither path supplies auth.
    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("warn");
    const check = result.checks.find((c) => c.code === "codex_missing_env");
    expect(check).toBeDefined();
    expect(check?.level).toBe("warn");
    expect(check?.detail).toBe("OPENAI_API_KEY");
    expect(check?.message).toContain("OPENAI_API_KEY");
    expect(check?.hint).toContain("OPENAI_API_KEY");
  });

  it("does NOT emit codex_missing_env when adapter env supplies the key", async () => {
    const result = await testEnvironment(
      makeCtx({ env: { OPENAI_API_KEY: "sk-from-adapter-config" } }),
    );

    const codes = result.checks.map((c) => c.code);
    expect(codes).not.toContain("codex_missing_env");
    expect(codes).toContain("codex_openai_api_key_present");
  });

  it("does NOT emit codex_missing_env when host process env supplies the key", async () => {
    process.env.OPENAI_API_KEY = "sk-from-host-env";

    const result = await testEnvironment(makeCtx());

    const codes = result.checks.map((c) => c.code);
    expect(codes).not.toContain("codex_missing_env");
    expect(codes).toContain("codex_openai_api_key_present");
  });
});

describe("testEnvironment — happy path", () => {
  it("does not emit any of the new disable-with-reason codes when env is healthy", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fixture";

    const result = await testEnvironment(makeCtx({ model: "gpt-5.3-codex" }));

    const codes = result.checks.map((c) => c.code);
    expect(codes).not.toContain("codex_local_cli_not_found");
    expect(codes).not.toContain("codex_unconfigured");
    expect(codes).not.toContain("codex_missing_env");
  });
});
