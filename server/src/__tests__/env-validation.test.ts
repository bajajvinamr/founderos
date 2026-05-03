import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateEnv, validateEnvOrExit } from "../lib/env-validation.js";

// Captured env so each test can mutate freely without leaking.
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env } as Record<string, string | undefined>;
  // Strip every key the validator looks at so each test starts from a known
  // baseline; individual cases re-add the keys they need.
  for (const k of [
    "SUPABASE_WEBHOOK_SECRET",
    "BETTER_AUTH_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "COMPOSIO_API_KEY",
    "COMPOSIO_V3_READY",
    "SENTRY_DSN",
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv as NodeJS.ProcessEnv;
});

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

// Synthetic check list for testing the validator's strict-mode logic
// without coupling to which specific production keys are REQUIRED. As of
// 2026-05-03 no production check is REQUIRED_IN_PROD (downgraded for safe
// first-deploy); tests inject their own to cover the strict path.
const TEST_CHECKS = [
  {
    name: "TEST_REQUIRED_KEY",
    keys: ["TEST_REQUIRED_KEY"],
    enables: "Synthetic critical feature",
    severity: "REQUIRED_IN_PROD" as const,
    hint: "Set TEST_REQUIRED_KEY for tests",
  },
  {
    name: "TEST_WARN_KEY",
    keys: ["TEST_WARN_KEY"],
    enables: "Synthetic optional feature",
    severity: "WARN" as const,
  },
  {
    name: "TEST_COMPOUND",
    keys: ["TEST_COMPOUND_A", "TEST_COMPOUND_B"],
    enables: "Synthetic compound feature",
    severity: "WARN" as const,
  },
];

describe("evaluateEnv", () => {
  it("classifies a fully unset environment against synthetic checks", () => {
    delete process.env.TEST_REQUIRED_KEY;
    delete process.env.TEST_WARN_KEY;
    delete process.env.TEST_COMPOUND_A;
    delete process.env.TEST_COMPOUND_B;
    const result = evaluateEnv(TEST_CHECKS);
    expect(result.hardFails.map((c) => c.name)).toContain("TEST_REQUIRED_KEY");
    expect(result.warns.map((c) => c.name)).toContain("TEST_WARN_KEY");
    expect(result.warns.map((c) => c.name)).toContain("TEST_COMPOUND");
    expect(result.oks).toHaveLength(0);
  });

  it("treats partial multi-key gates as missing", () => {
    process.env.TEST_COMPOUND_A = "set";
    // TEST_COMPOUND_B intentionally left unset.
    const result = evaluateEnv(TEST_CHECKS);
    expect(result.warns.map((c) => c.name)).toContain("TEST_COMPOUND");
    expect(result.oks.map((c) => c.name)).not.toContain("TEST_COMPOUND");
  });

  it("treats whitespace-only env values as missing", () => {
    process.env.TEST_WARN_KEY = "   ";
    const result = evaluateEnv(TEST_CHECKS);
    expect(result.warns.map((c) => c.name)).toContain("TEST_WARN_KEY");
  });

  it("classifies fully populated env as all-OK", () => {
    process.env.TEST_REQUIRED_KEY = "set";
    process.env.TEST_WARN_KEY = "set";
    process.env.TEST_COMPOUND_A = "set";
    process.env.TEST_COMPOUND_B = "set";
    const result = evaluateEnv(TEST_CHECKS);
    expect(result.hardFails).toHaveLength(0);
    expect(result.warns).toHaveLength(0);
    expect(result.infos).toHaveLength(0);
    expect(result.oks).toHaveLength(TEST_CHECKS.length);
  });

  it("default (no override) uses the production CHECKS table without crashing", () => {
    // Sanity — the default path must work even when nothing is set.
    expect(() => evaluateEnv()).not.toThrow();
  });
});

describe("validateEnvOrExit", () => {
  it("throws synchronously when strict and a REQUIRED gate is missing", () => {
    delete process.env.TEST_REQUIRED_KEY;
    const logger = fakeLogger();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      expect(() =>
        validateEnvOrExit({ strict: true, logger, checks: TEST_CHECKS }),
      ).toThrow(/Missing required env vars/);
      expect(logger.error).toHaveBeenCalled();
      expect(logger.fatal).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("does NOT throw when strict but all REQUIRED gates are set", () => {
    process.env.TEST_REQUIRED_KEY = "set";
    const logger = fakeLogger();
    expect(() =>
      validateEnvOrExit({ strict: true, logger, checks: TEST_CHECKS }),
    ).not.toThrow();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it("does NOT throw when not strict, even with REQUIRED gates missing — only emits error log", () => {
    delete process.env.TEST_REQUIRED_KEY;
    const logger = fakeLogger();
    expect(() =>
      validateEnvOrExit({ strict: false, logger, checks: TEST_CHECKS }),
    ).not.toThrow();
    // REQUIRED_IN_PROD missing under non-strict still emits an `error` log
    // (so dev sees the issue) but does not exit.
    expect(logger.error).toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });
});
