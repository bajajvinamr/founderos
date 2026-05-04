/**
 * BYO-005 — Feature flag regression test.
 *
 * Validates that:
 *   1. `isByoRunnerEnabled()` is the single source of truth.
 *   2. Default is OFF (unset env → false).
 *   3. Truthy value (`'1'`) flips it on.
 *   4. The env-validation table includes the flag as INFO severity.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isByoRunnerEnabled } from "../lib/byo-runner-flag.js";
import { evaluateEnv } from "../lib/env-validation.js";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.FOUNDEROS_BYO_RUNNER_ENABLED;
  } else {
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = saved;
  }
});

describe("isByoRunnerEnabled", () => {
  it("returns false when env var is unset", () => {
    expect(isByoRunnerEnabled()).toBe(false);
  });

  it("returns true when env var is exactly '1'", () => {
    process.env.FOUNDEROS_BYO_RUNNER_ENABLED = "1";
    expect(isByoRunnerEnabled()).toBe(true);
  });

  it("returns false for other truthy-looking values", () => {
    // Strict '1' contract — matches the COMPOSIO_V3_READY pattern in the
    // codebase. Loose truthy values would let "true" or "yes" silently flip
    // gates in environments where someone copy-pasted from the wrong doc.
    for (const v of ["true", "yes", "on", "TRUE", " 1 ", "0"]) {
      process.env.FOUNDEROS_BYO_RUNNER_ENABLED = v;
      expect(isByoRunnerEnabled()).toBe(false);
    }
  });
});

describe("env-validation entry for BYO Runner", () => {
  it("FOUNDEROS_BYO_RUNNER_ENABLED is registered as INFO severity", () => {
    const result = evaluateEnv();
    const all = [...result.infos, ...result.warns, ...result.hardFails, ...result.oks];
    const entry = all.find((c) => c.name === "FOUNDEROS_BYO_RUNNER_ENABLED");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("INFO");
    expect(entry?.enables).toMatch(/byo_runner/i);
  });
});
