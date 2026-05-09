/**
 * CLI flag parser tests (v0.1.1).
 *
 * The parser must accept both `--key=value` and `--key value` forms because
 * Windows PowerShell sometimes mangles `=` in args, and shell scripts on
 * macOS/Linux idiomatically use the space-separated form.
 */

import { describe, it, expect } from "vitest";
import { parseFlags } from "../cli.js";

describe("parseFlags", () => {
  it("parses --key=value form", () => {
    const { overrides, unknown } = parseFlags([
      "--token=fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--server-url=https://founderos.fly.dev",
    ]);
    expect(unknown).toEqual([]);
    expect(overrides.token).toBe("fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(overrides.serverUrl).toBe("https://founderos.fly.dev");
  });

  it("parses --key value form (space-separated)", () => {
    const { overrides, unknown } = parseFlags([
      "--token",
      "fos_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "--server-url",
      "https://founderos.fly.dev",
    ]);
    expect(unknown).toEqual([]);
    expect(overrides.token).toBe("fos_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(overrides.serverUrl).toBe("https://founderos.fly.dev");
  });

  it("parses mixed forms in one invocation", () => {
    const { overrides, unknown } = parseFlags([
      "--token=fos_cccccccccccccccccccccccccccccccc",
      "--server-url",
      "https://founderos.fly.dev",
      "--log-level=debug",
    ]);
    expect(unknown).toEqual([]);
    expect(overrides.token).toBe("fos_cccccccccccccccccccccccccccccccc");
    expect(overrides.serverUrl).toBe("https://founderos.fly.dev");
    expect(overrides.logLevel).toBe("debug");
  });

  it("parses --timeout-sec as a number", () => {
    const { overrides } = parseFlags(["--timeout-sec=300"]);
    expect(overrides.defaultTimeoutSec).toBe(300);
    expect(typeof overrides.defaultTimeoutSec).toBe("number");
  });

  it("rejects non-numeric --timeout-sec by reporting unknown", () => {
    const { overrides, unknown } = parseFlags(["--timeout-sec=not-a-number"]);
    expect(overrides.defaultTimeoutSec).toBeUndefined();
    expect(unknown).toContain("--timeout-sec=not-a-number");
  });

  it("reports unknown flags", () => {
    const { overrides, unknown } = parseFlags(["--mystery-flag=foo"]);
    expect(overrides).toEqual({});
    expect(unknown).toContain("--mystery-flag=foo");
  });

  it("rejects bare positional args", () => {
    const { unknown } = parseFlags(["start", "--token=fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(unknown).toContain("start");
  });

  it("treats empty value as unknown (defensive)", () => {
    const { overrides, unknown } = parseFlags(["--token="]);
    expect(overrides.token).toBeUndefined();
    expect(unknown).toContain("--token=");
  });

  it("does not consume next arg as value when it starts with --", () => {
    // The user typed `--token` but forgot the value. The parser should
    // NOT consume `--server-url=...` as the token's value.
    const { overrides, unknown } = parseFlags([
      "--token",
      "--server-url=https://founderos.fly.dev",
    ]);
    expect(overrides.token).toBeUndefined();
    expect(overrides.serverUrl).toBe("https://founderos.fly.dev");
    expect(unknown).toContain("--token");
  });

  it("handles --claude-bin pointing at a Windows-style path", () => {
    const { overrides, unknown } = parseFlags([
      "--claude-bin=C:\\Users\\bansa\\AppData\\Local\\claude\\claude.exe",
    ]);
    expect(unknown).toEqual([]);
    expect(overrides.claudeBin).toBe(
      "C:\\Users\\bansa\\AppData\\Local\\claude\\claude.exe",
    );
  });
});
