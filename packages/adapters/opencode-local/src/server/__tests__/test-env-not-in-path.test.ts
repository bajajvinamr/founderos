/**
 * Honest-disable tests for opencode-local: testEnvironment() returns "warn"
 * with code "opencode_local_cli_not_found" when the `opencode` binary is not in PATH.
 *
 * Pattern established by TA03/TA04 for CLI-bound adapters (FUSED).
 */
import { describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@founderos/adapter-utils";
import { testEnvironment } from "../test.js";

// ---------------------------------------------------------------------------
// Mock child_process so the binary-check call to execSync throws.
// Module-level vi.mock is hoisted before imports by Vitest's transformer,
// so `execSync` is replaced before testEnvironment runs.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execSync: vi.fn((cmd: string) => {
      // Simulate "which opencode: not found" for the binary availability check.
      if (typeof cmd === "string" && cmd.startsWith("which ")) {
        throw new Error("not found");
      }
      return Buffer.from("");
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(config: Record<string, unknown> = {}): AdapterEnvironmentTestContext {
  return {
    companyId: "test-company",
    adapterType: "opencode_local",
    config,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("testEnvironment — CLI binary not in PATH", () => {
  it("returns status \"warn\" with code \"opencode_local_cli_not_found\"", async () => {
    const result = await testEnvironment(makeCtx());

    expect(result.status).toBe("warn");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("opencode_local_cli_not_found");
    expect(result.checks[0].level).toBe("warn");
    expect(result.checks[0].message).toContain("OpenCode CLI");
    expect(result.checks[0].hint).toContain("/settings/runner");
  });

  it("returns immediately without further checks — even with invalid cwd", async () => {
    const result = await testEnvironment(makeCtx({ cwd: "/nonexistent/path/xyz" }));

    // When the binary is absent the early-return fires first —
    // no cwd validation or command check is attempted.
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("opencode_local_cli_not_found");
  });
});
