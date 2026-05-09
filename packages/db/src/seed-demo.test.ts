/**
 * P0 audit finding #5: seed-demo* scripts must refuse to run unless
 * `FOUNDEROS_SEED_DEMO=1` is set in the environment.
 *
 * These tests spawn each seed script as a subprocess via `tsx` and assert:
 *   - Exit code 1 when FOUNDEROS_SEED_DEMO is unset, ""1"" → other, etc.
 *   - The refusal message names the env var the user must set.
 *   - The script exits BEFORE attempting any DB connection (i.e. no
 *     DATABASE_URL is required to trigger the gate — it must be the very
 *     first thing the script does).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Use the package-local tsx so the test does not assume a global install.
const PACKAGE_ROOT = path.resolve(HERE, "..");
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");

const SCRIPTS = [
  "seed-demo.ts",
  "seed-demo-depth.ts",
  "seed-demo-narrative.ts",
  "seed-demo-reset.ts",
] as const;

type RunResult = { status: number | null; stdout: string; stderr: string };

function runScript(
  script: string,
  env: Record<string, string | undefined>,
): RunResult {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) filtered[k] = v;
  }
  const result = spawnSync(TSX_BIN, [path.join(HERE, script)], {
    cwd: PACKAGE_ROOT,
    env: filtered,
    encoding: "utf8",
    // Cap output so a script that misbehaves and tries to seed against a
    // real DB can't blow up the test runner. The gate must short-circuit
    // long before any output.
    maxBuffer: 1024 * 64,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

describe("FOUNDEROS_SEED_DEMO env gate (P0 audit finding #5)", () => {
  for (const script of SCRIPTS) {
    describe(script, () => {
      it("refuses when FOUNDEROS_SEED_DEMO is unset", () => {
        // Note: NO DATABASE_URL on purpose. The gate must trigger before
        // the DATABASE_URL check, otherwise a buyer running this without
        // the env var would still hit a less-clear error.
        const r = runScript(script, { PATH: process.env.PATH });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Refusing to run/);
        expect(r.stderr).toMatch(/FOUNDEROS_SEED_DEMO=1/);
      });

      it("refuses when FOUNDEROS_SEED_DEMO is set to a non-1 value", () => {
        const r = runScript(script, {
          PATH: process.env.PATH,
          FOUNDEROS_SEED_DEMO: "true", // common mistake
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Refusing to run/);
      });

      it("refuses when FOUNDEROS_SEED_DEMO is empty string", () => {
        const r = runScript(script, {
          PATH: process.env.PATH,
          FOUNDEROS_SEED_DEMO: "",
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Refusing to run/);
      });

      it("refers users to the runbook in the refusal message", () => {
        const r = runScript(script, { PATH: process.env.PATH });
        expect(r.stderr).toMatch(/docs\/runbooks\/seed-demo\.md/);
      });
    });
  }

  it("seed-demo.ts proceeds past the env gate when FOUNDEROS_SEED_DEMO=1 (then fails for missing DATABASE_URL)", () => {
    // With the gate satisfied but no DATABASE_URL, the script should die
    // at the DATABASE_URL check, NOT at the gate. This is the
    // positive-case proof that the gate is a separate layer.
    const r = runScript("seed-demo.ts", {
      PATH: process.env.PATH,
      FOUNDEROS_SEED_DEMO: "1",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/Refusing to run/);
    // Should hit the DATABASE_URL guard inside the script.
    expect(r.stderr + r.stdout).toMatch(/DATABASE_URL/);
  });
});
