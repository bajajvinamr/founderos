import { describe, it, expect } from "vitest";
import { loadConfig, RunnerConfigError } from "../config.js";

const VALID_TOKEN = "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("loadConfig", () => {
  it("returns a normalized config when env is well-formed", () => {
    const cfg = loadConfig({
      FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev/",
      FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
      FOUNDEROS_CLAUDE_BIN: "/usr/local/bin/claude",
      FOUNDEROS_RUNNER_TIMEOUT_SEC: "300",
      FOUNDEROS_RUNNER_LOG_LEVEL: "debug",
    });
    // Trailing slash is normalized so route concatenation is predictable.
    expect(cfg.serverUrl).toBe("https://founderos.fly.dev");
    expect(cfg.token).toBe(VALID_TOKEN);
    expect(cfg.claudeBin).toBe("/usr/local/bin/claude");
    expect(cfg.defaultTimeoutSec).toBe(300);
    expect(cfg.logLevel).toBe("debug");
  });

  it("uses sensible defaults when optional vars are unset", () => {
    const cfg = loadConfig({
      FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev",
      FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
    });
    expect(cfg.claudeBin).toBe("claude");
    expect(cfg.defaultTimeoutSec).toBe(600);
    expect(cfg.logLevel).toBe("info");
  });

  it("rejects missing url", () => {
    expect(() => loadConfig({ FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN })).toThrow(RunnerConfigError);
  });

  it("rejects malformed token (preserves the contract from runner-auth middleware)", () => {
    expect(() =>
      loadConfig({
        FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev",
        FOUNDEROS_RUNNER_TOKEN: "fos_too-short",
      }),
    ).toThrow(/fos_<32 alphanumeric>/);
  });

  it("rejects file:// URL (non-http schemes are a footgun for SSRF)", () => {
    expect(() =>
      loadConfig({
        FOUNDEROS_RUNNER_URL: "file:///etc/passwd",
        FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
      }),
    ).toThrow(/must be http/);
  });

  it("rejects timeout outside the 1..3600 range", () => {
    expect(() =>
      loadConfig({
        FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev",
        FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
        FOUNDEROS_RUNNER_TIMEOUT_SEC: "0",
      }),
    ).toThrow(/1\.\.3600/);
    expect(() =>
      loadConfig({
        FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev",
        FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
        FOUNDEROS_RUNNER_TIMEOUT_SEC: "7200",
      }),
    ).toThrow(/1\.\.3600/);
  });

  it("rejects unknown log level", () => {
    expect(() =>
      loadConfig({
        FOUNDEROS_RUNNER_URL: "https://founderos.fly.dev",
        FOUNDEROS_RUNNER_TOKEN: VALID_TOKEN,
        FOUNDEROS_RUNNER_LOG_LEVEL: "verbose",
      }),
    ).toThrow(/debug\|info\|warn\|error/);
  });
});
