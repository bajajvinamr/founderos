import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentJwtSecretAtBoot } from "../boot/jwt-secret-bootstrap.js";

// Capture process.env so each test can mutate freely without cross-test
// leakage. The bootstrap module reads + writes process.env.NODE_ENV and
// process.env.FOUNDEROS_AGENT_JWT_SECRET.
const ORIGINAL_ENV = { ...process.env };

function tempEnvFilePath(prefix = "founderos-jwt-bootstrap-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Mirror the real layout: <root>/.founderos/.env
  const subdir = path.join(dir, ".founderos");
  fs.mkdirSync(subdir, { recursive: true });
  return path.join(subdir, ".env");
}

describe("ensureAgentJwtSecretAtBoot", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FOUNDEROS_AGENT_JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("auto-bootstraps in development: generates secret, writes file, injects into process.env", () => {
    process.env.NODE_ENV = "development";
    const envFilePath = tempEnvFilePath();
    expect(fs.existsSync(envFilePath)).toBe(false);

    const result = ensureAgentJwtSecretAtBoot({ envFilePath });

    expect(result.created).toBe(true);
    expect(result.loadedFromFile).toBe(false);
    expect(result.envFilePath).toBe(envFilePath);

    // process.env populated
    const secret = process.env.FOUNDEROS_AGENT_JWT_SECRET;
    expect(typeof secret).toBe("string");
    expect(secret!.length).toBeGreaterThan(32); // 32 bytes hex = 64 chars

    // File written with the same secret + 0o600 mode
    expect(fs.existsSync(envFilePath)).toBe(true);
    const contents = fs.readFileSync(envFilePath, "utf-8");
    expect(contents).toContain(`FOUNDEROS_AGENT_JWT_SECRET=${secret}`);

    // POSIX mode check (skip on Windows where `mode & 0o777` semantics differ).
    if (process.platform !== "win32") {
      const stat = fs.statSync(envFilePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("is a no-op when the secret is already present in process.env", () => {
    process.env.NODE_ENV = "development";
    process.env.FOUNDEROS_AGENT_JWT_SECRET = "preset-secret-from-fly";
    const envFilePath = tempEnvFilePath();

    const result = ensureAgentJwtSecretAtBoot({ envFilePath });

    expect(result.created).toBe(false);
    expect(result.loadedFromFile).toBe(false);
    expect(process.env.FOUNDEROS_AGENT_JWT_SECRET).toBe("preset-secret-from-fly");
    // No file created — bootstrap shouldn't touch disk when env is already set
    expect(fs.existsSync(envFilePath)).toBe(false);
  });

  it("loads from existing env file when secret is on disk but not in process.env", () => {
    process.env.NODE_ENV = "development";
    const envFilePath = tempEnvFilePath();
    fs.writeFileSync(
      envFilePath,
      "FOUNDEROS_AGENT_JWT_SECRET=existing-secret-from-prior-boot\n",
      { mode: 0o600 },
    );

    const result = ensureAgentJwtSecretAtBoot({ envFilePath });

    expect(result.created).toBe(false);
    expect(result.loadedFromFile).toBe(true);
    expect(process.env.FOUNDEROS_AGENT_JWT_SECRET).toBe(
      "existing-secret-from-prior-boot",
    );
  });

  it("throws in production when secret is missing", () => {
    process.env.NODE_ENV = "production";
    const envFilePath = tempEnvFilePath();

    expect(() => ensureAgentJwtSecretAtBoot({ envFilePath })).toThrow(
      /FOUNDEROS_AGENT_JWT_SECRET must be set in production/,
    );
    // No file generated — production must NOT auto-rotate the key on each
    // deploy (would invalidate every in-flight agent JWT).
    expect(fs.existsSync(envFilePath)).toBe(false);
    expect(process.env.FOUNDEROS_AGENT_JWT_SECRET).toBeUndefined();
  });

  it("auto-bootstraps under NODE_ENV=test (treated like dev)", () => {
    process.env.NODE_ENV = "test";
    const envFilePath = tempEnvFilePath();

    const result = ensureAgentJwtSecretAtBoot({ envFilePath });

    expect(result.created).toBe(true);
    expect(typeof process.env.FOUNDEROS_AGENT_JWT_SECRET).toBe("string");
  });

  it("auto-bootstraps when NODE_ENV is unset (also treated like dev — first-run safety)", () => {
    delete process.env.NODE_ENV;
    const envFilePath = tempEnvFilePath();

    const result = ensureAgentJwtSecretAtBoot({ envFilePath });

    expect(result.created).toBe(true);
    expect(typeof process.env.FOUNDEROS_AGENT_JWT_SECRET).toBe("string");
  });

  it("preserves unrelated entries when writing to an existing env file", () => {
    process.env.NODE_ENV = "development";
    const envFilePath = tempEnvFilePath();
    fs.writeFileSync(
      envFilePath,
      [
        "# pre-existing comment",
        "FOUNDEROS_WORKTREE_COLOR=#439edb",
        "ANOTHER_KEY=value",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    ensureAgentJwtSecretAtBoot({ envFilePath });

    const contents = fs.readFileSync(envFilePath, "utf-8");
    expect(contents).toContain("FOUNDEROS_AGENT_JWT_SECRET=");
    expect(contents).toContain("FOUNDEROS_WORKTREE_COLOR=");
    expect(contents).toContain("ANOTHER_KEY=value");
  });
});
