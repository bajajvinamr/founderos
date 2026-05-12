/**
 * L2-A07 — Adapter registry contract test.
 *
 * Walks every adapter registered in the server's adapter registry and asserts
 * that each one conforms uniformly to the ServerAdapterModule contract
 * tightened across Loop 1 + early Loop 2:
 *
 *   - PR #194 (2efbe94)  completed the ServerAdapterModule contract for
 *                        openai_api + gemini_api — every registered adapter
 *                        must expose `execute` + `testEnvironment` with
 *                        uniform return shapes.
 *   - PR #202            CLI honest-disable — testEnvironment returns the
 *                        AdapterEnvironmentTestResult shape with a discriminated
 *                        `status` ("pass" | "warn" | "fail") and an array of
 *                        AdapterEnvironmentCheck rows; "disabled" surfaces
 *                        as one or more `level: "error"` checks with
 *                        machine-readable snake_case `code` strings.
 *   - PR #215 (L2-A02)   Codex environmentChecks rigor — established the
 *                        snake_case disable-reason convention enforced here
 *                        (`/^[a-z0-9_]+$/`).
 *
 * Why this test exists: the registry happily accepts any object whose `type`
 * field is a string. Without an automated guard, the next adapter to ship
 * (external plugin or built-in) can drift from the contract and the failure
 * surfaces only at runtime, in a single founder's session, after registration.
 *
 * Today every registered adapter conforms — this test should PASS green.
 * If a future adapter diverges, this test FAILS with the offending `type`
 * and the specific shape rule it broke. Do not allowlist; fix the adapter.
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import {
  listServerAdapters,
  waitForExternalAdapters,
} from "../adapters/registry.js";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../adapters/types.js";

/** snake_case + digits + underscore only; matches the convention codified
 *  across openai_api, gemini_api, codex_local, claude_local, gemini_local,
 *  cursor_local, opencode_local, pi_local, openclaw_gateway, process, http. */
const SNAKE_CASE_CODE = /^[a-z0-9_]+$/;

const VALID_LEVELS = new Set<AdapterEnvironmentCheck["level"]>([
  "info",
  "warn",
  "error",
]);

const VALID_STATUSES = new Set<AdapterEnvironmentTestResult["status"]>([
  "pass",
  "warn",
  "fail",
]);

/** Build a minimal test-environment context for an adapter. We deliberately
 *  point `command` at a path that will not resolve so adapters that probe
 *  child processes (codex_local, claude_local, etc.) short-circuit on the
 *  command-resolvable check and skip the hello probe. `cwd` is os.tmpdir()
 *  so adapters that ensure-absolute-directory succeed. URL-based adapters
 *  (http, openclaw_gateway) take an empty url path which exercises their
 *  url-missing check without making a network call. */
function buildContext(adapterType: string): AdapterEnvironmentTestContext {
  return {
    companyId: "00000000-0000-0000-0000-000000000000",
    adapterType,
    config: {
      command: "/nonexistent/contract-test-binary",
      cwd: os.tmpdir(),
      // openclaw_gateway / http: leave url unset → triggers their url_missing
      // check (error-level), which is a valid contract-conformant response.
    },
    deployment: {
      mode: "local_trusted",
      exposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: ["127.0.0.1"],
    },
  };
}

describe("ServerAdapterModule contract — registry walk", () => {
  it("every registered adapter conforms uniformly to the contract", async () => {
    // Wait for external plugin adapters to finish async load before walking.
    await waitForExternalAdapters();

    const adapters = listServerAdapters();
    expect(adapters.length).toBeGreaterThan(0);

    // ── 1. `type` is a non-empty string AND unique within the registry ────
    const types = adapters.map((a) => a.type);
    const seen = new Set<string>();
    for (const t of types) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
      expect(seen.has(t), `duplicate adapter.type "${t}" in registry`).toBe(
        false,
      );
      seen.add(t);
    }

    // ── 2. Required methods have the contracted shape ─────────────────────
    // NOTE on arity: the ServerAdapterModule interface specifies one
    // parameter for execute() and testEnvironment(), but TypeScript's
    // optional-param syntax (`apiKeyResolver?: ApiKeyResolver`) compiles to
    // a function whose .length is 2 even though it's still callable with
    // one arg. PR #198 (apiKeyResolver injection) introduced this for
    // gemini_api/openai_api. We therefore assert .length <= 2 — anything
    // higher signals a required second arg the interface does not allow.
    for (const adapter of adapters) {
      expect(typeof adapter.execute, `${adapter.type}.execute is not a function`).toBe(
        "function",
      );
      expect(
        adapter.execute.length,
        `${adapter.type}.execute has too many required parameters (.length=${adapter.execute.length}); the interface allows only a single context arg plus optional injected dependencies`,
      ).toBeLessThanOrEqual(2);

      expect(
        typeof adapter.testEnvironment,
        `${adapter.type}.testEnvironment is not a function`,
      ).toBe("function");
      expect(
        adapter.testEnvironment.length,
        `${adapter.type}.testEnvironment has too many required parameters (.length=${adapter.testEnvironment.length}); the interface allows only a single context arg`,
      ).toBeLessThanOrEqual(2);
    }

    // ── 3. Optional skill methods, when present, have the contracted shape ─
    for (const adapter of adapters) {
      if (adapter.listSkills !== undefined) {
        expect(
          typeof adapter.listSkills,
          `${adapter.type}.listSkills must be a function when present`,
        ).toBe("function");
      }
      if (adapter.syncSkills !== undefined) {
        expect(
          typeof adapter.syncSkills,
          `${adapter.type}.syncSkills must be a function when present`,
        ).toBe("function");
      }
      if (adapter.detectModel !== undefined) {
        expect(typeof adapter.detectModel).toBe("function");
      }
      if (adapter.getQuotaWindows !== undefined) {
        expect(typeof adapter.getQuotaWindows).toBe("function");
      }
    }

    // ── 4. testEnvironment() returns the contracted AdapterEnvironmentTestResult ─
    // This is the heart of the contract: every adapter must surface its
    // environment state in the same shape, with snake_case `code` strings,
    // a discriminated `status`, and a stable `level` enum on each check.
    for (const adapter of adapters) {
      const ctx = buildContext(adapter.type);
      let result: AdapterEnvironmentTestResult;
      try {
        result = await adapter.testEnvironment(ctx);
      } catch (err) {
        // Any adapter that throws from testEnvironment instead of returning
        // a structured fail-status result is a contract violation — the
        // whole point of #202's honest-disable is that disable surfaces as
        // checks, not exceptions.
        throw new Error(
          `${adapter.type}.testEnvironment threw instead of returning a result: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // 4a. result is a plain object with the four required fields
      expect(result, `${adapter.type}: testEnvironment returned non-object`).toBeTypeOf(
        "object",
      );
      expect(result).not.toBeNull();

      // 4b. adapterType echoes back (allows the caller to route results
      //     without retaining the request). The contract permits the
      //     adapter to echo ctx.adapterType (most common) — we just check
      //     it's a non-empty string. byo_runner hardcodes its own type;
      //     that's fine because it matches its registered type.
      expect(
        typeof result.adapterType,
        `${adapter.type}.testEnvironment().adapterType is not a string`,
      ).toBe("string");
      expect(result.adapterType.length).toBeGreaterThan(0);

      // 4c. status is one of the discriminated enum members
      expect(
        VALID_STATUSES.has(result.status),
        `${adapter.type}.testEnvironment().status="${result.status}" is not pass|warn|fail`,
      ).toBe(true);

      // 4d. testedAt is a parseable ISO timestamp
      expect(typeof result.testedAt).toBe("string");
      expect(
        Number.isFinite(Date.parse(result.testedAt)),
        `${adapter.type}.testEnvironment().testedAt="${result.testedAt}" is not parseable`,
      ).toBe(true);

      // 4e. checks is an array (may be empty for adapters that have
      //     nothing to report under the test context — e.g., process if
      //     command resolves trivially). Each check obeys the row contract.
      expect(Array.isArray(result.checks), `${adapter.type}.checks is not an array`).toBe(
        true,
      );

      for (const check of result.checks) {
        // 4e.i. code is snake_case (no spaces, no uppercase, no dots).
        // This is the key invariant #215 enforced for codex_local and
        // #194 documented for openai_api + gemini_api — codes must be
        // machine-readable and parseable for downstream UI mapping.
        expect(
          typeof check.code,
          `${adapter.type}: check.code must be a string`,
        ).toBe("string");
        expect(
          SNAKE_CASE_CODE.test(check.code),
          `${adapter.type}: check.code "${check.code}" violates snake_case contract /^[a-z0-9_]+$/`,
        ).toBe(true);

        // 4e.ii. level is one of the enum members
        expect(
          VALID_LEVELS.has(check.level),
          `${adapter.type}: check.level "${check.level}" for code "${check.code}" is not info|warn|error`,
        ).toBe(true);

        // 4e.iii. message is a non-empty string (operator-facing)
        expect(
          typeof check.message,
          `${adapter.type}: check.message for code "${check.code}" is not a string`,
        ).toBe("string");
        expect(check.message.length).toBeGreaterThan(0);

        // 4e.iv. optional `detail` and `hint` are strings or null when set
        if (check.detail !== undefined && check.detail !== null) {
          expect(typeof check.detail).toBe("string");
        }
        if (check.hint !== undefined && check.hint !== null) {
          expect(typeof check.hint).toBe("string");
        }
      }

      // 4f. The status discriminator agrees with the worst level in checks:
      //     any error → fail; any warn (no error) → warn; otherwise pass.
      //     This is what every adapter's summarizeStatus helper enforces;
      //     surfacing it here catches divergence.
      const hasError = result.checks.some((c) => c.level === "error");
      const hasWarn = result.checks.some((c) => c.level === "warn");
      const expectedStatus = hasError ? "fail" : hasWarn ? "warn" : "pass";
      expect(
        result.status,
        `${adapter.type}: status "${result.status}" disagrees with checks (expected "${expectedStatus}" from levels ${result.checks
          .map((c) => c.level)
          .join(",")})`,
      ).toBe(expectedStatus);
    }
  });

  it("registers more than one adapter (sanity)", async () => {
    await waitForExternalAdapters();
    const adapters = listServerAdapters();
    // As of 2efbe94 the registry ships at least: claude_local, codex_local,
    // cursor_local, gemini_local, openai_api, gemini_api, openclaw_gateway,
    // opencode_local, pi_local, hermes_local, process, http. byo_runner is
    // registered at app startup conditionally. Floor: 10 to catch regressions
    // where a refactor accidentally drops the registry.
    expect(adapters.length).toBeGreaterThanOrEqual(10);
  });
});
