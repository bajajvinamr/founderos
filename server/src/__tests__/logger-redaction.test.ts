/**
 * Tests for pino's path-based redaction list (PR-7, council 2026-05-07 P1).
 *
 * Pre-fix, `redact: ["req.headers.authorization"]` covered ONE path. Direct
 * `logger.info({ signupUrl: "https://founderos.fly.dev/auth?invite=pcp_xxx" })`
 * calls leaked the raw token straight to log destinations (file, stdout
 * pretty-printed, downstream Sentry/log-drains). The discovery synthesis
 * (`.qa/reports/security-privacy.md`) flagged this as a P1 leak.
 *
 * Post-fix, `REDACT_PATHS` is exported from logger.ts and includes:
 *   - HTTP request headers carrying tokens
 *   - Top-level keys used by direct `logger.*` call sites: signupUrl,
 *     token, password, magicLinkToken, runnerToken, etc.
 *
 * These tests construct a tiny pino logger with the same redact config but
 * piped into a captureable stream (no transport worker, no file IO). The
 * captured output is asserted to contain "[redacted]" instead of the
 * sensitive value. Same assertion shape for every key in REDACT_PATHS so
 * a future addition is automatically tested.
 */

import { describe, expect, it } from "vitest";
import pino from "pino";
import { REDACT_PATHS, REDACT_CENSOR } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Test harness — capture pino output via an in-memory writable.
// ---------------------------------------------------------------------------

function makeCapturedLogger() {
  const writes: string[] = [];
  const stream = {
    write(msg: string) {
      writes.push(msg);
    },
  };
  const logger = pino(
    {
      level: "trace",
      // Mirror production config exactly — paths + censor — so the test
      // catches drift in either dimension.
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    },
    stream as unknown as NodeJS.WritableStream,
  );
  return { logger, writes };
}

// Sample sensitive payload. Each key matches an entry in REDACT_PATHS — the
// test asserts that for EVERY top-level key listed in REDACT_PATHS, the
// raw value is replaced with "[redacted]" in the serialized log line.
const SAMPLE_VALUES: Record<string, string> = {
  signupUrl: "https://founderos.fly.dev/auth?invite=pcp_VERYSECRET_xyz123",
  signup_url: "https://founderos.fly.dev/auth?invite=pcp_snake_secret",
  inviteUrl: "https://founderos.fly.dev/invite/inv_secret_url",
  invite_url: "https://founderos.fly.dev/invite/inv_secret_snake",
  token: "tok_VERYSECRET_abc",
  password: "hunter2-VERYSECRET",
  apiKey: "sk-VERYSECRET-api-key",
  api_key: "sk-VERYSECRET-snake-api-key",
  secret: "VERYSECRET-bare-secret",
  credentials: "VERYSECRET-credentials-blob",
  credential: "VERYSECRET-singular-cred",
  privateKey: "-----BEGIN VERYSECRET PRIVATE KEY-----",
  private_key: "-----BEGIN VERYSECRET SNAKE KEY-----",
  refreshToken: "rt_VERYSECRET_refresh",
  refresh_token: "rt_VERYSECRET_snake_refresh",
  accessToken: "at_VERYSECRET_access",
  access_token: "at_VERYSECRET_snake_access",
  clientSecret: "cs_VERYSECRET_client",
  client_secret: "cs_VERYSECRET_snake_client",
  magicLinkToken: "mlt_VERYSECRET_magic_link",
  magic_link_token: "mlt_VERYSECRET_snake_magic_link",
  runnerToken: "fos_VERYSECRET_runner",
  runner_token: "fos_VERYSECRET_snake_runner",
  authorization: "Bearer VERYSECRET_jwt_xyz",
};

describe("logger redaction — top-level keys (PR-7)", () => {
  it("redacts every top-level key listed in REDACT_PATHS", () => {
    // Filter REDACT_PATHS to top-level keys only (no dotted paths). These
    // are the ones whose VALUES we expect to be redacted in the log JSON.
    const topLevelPaths = REDACT_PATHS.filter((p) => !p.includes(".") && !p.startsWith("req"));

    const { logger, writes } = makeCapturedLogger();

    // Build a single payload with every sample value present, then log it.
    // pino's redact list applies path-by-path, so all topLevelPaths should
    // end up redacted in the same emitted record.
    const payload: Record<string, string> = {};
    for (const key of topLevelPaths) {
      // Some paths use bracket notation (`req.headers["x-runner-token"]`)
      // which won't appear in topLevelPaths because they include a dot.
      // We use only bare keys here. Every bare key in REDACT_PATHS must
      // have a SAMPLE_VALUES entry — keeps the test in sync with the
      // production list.
      expect(SAMPLE_VALUES).toHaveProperty(key);
      payload[key] = SAMPLE_VALUES[key]!;
    }

    logger.info(payload, "test redaction");
    const output = writes.join("");

    // Every original raw value must be gone from the output.
    for (const key of topLevelPaths) {
      const rawValue = SAMPLE_VALUES[key]!;
      expect(output, `${key} value '${rawValue}' leaked into log output`).not.toContain(rawValue);
      // And the [redacted] sentinel must be present for the key.
      expect(output, `${key} not redacted in log output`).toContain(`"${key}":"[redacted]"`);
    }
  });

  it("redacts signupUrl specifically — the original P1 leak case", () => {
    const { logger, writes } = makeCapturedLogger();
    const signupUrl = "https://founderos.fly.dev/auth?invite=pcp_REPRO_LEAK_TOKEN_xyz";
    logger.info(
      { to: "victim@example.com", signupUrl },
      "instance invite: email sender disabled — admin must share signup URL manually",
    );
    const output = writes.join("");
    expect(output).not.toContain("pcp_REPRO_LEAK_TOKEN_xyz");
    expect(output).toContain('"signupUrl":"[redacted]"');
    // Sanity: non-sensitive context still survives — proves we're not
    // over-redacting.
    expect(output).toContain("victim@example.com");
  });

  it("redacts request-header tokens (Authorization, Cookie, x-runner-token, x-api-key)", () => {
    const { logger, writes } = makeCapturedLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer VERYSECRET_jwt",
            cookie: "session=VERYSECRET_session_cookie",
            "x-runner-token": "fos_VERYSECRET_runner",
            "x-api-key": "sk-VERYSECRET-api-key",
            // Sanity: an innocuous header should NOT be redacted.
            "user-agent": "test-runner/1.0",
          },
        },
      },
      "request log",
    );
    const output = writes.join("");
    expect(output).not.toContain("VERYSECRET_jwt");
    expect(output).not.toContain("VERYSECRET_session_cookie");
    expect(output).not.toContain("VERYSECRET_runner");
    expect(output).not.toContain("VERYSECRET-api-key");
    expect(output).toContain('"authorization":"[redacted]"');
    expect(output).toContain('"cookie":"[redacted]"');
    expect(output).toContain('"x-runner-token":"[redacted]"');
    expect(output).toContain('"x-api-key":"[redacted]"');
    // user-agent must pass through.
    expect(output).toContain("test-runner/1.0");
  });

  it("does not over-redact: arbitrary unrelated keys flow through unchanged", () => {
    const { logger, writes } = makeCapturedLogger();
    const benignPayload = {
      userId: "user-123",
      companyId: "co-456",
      requestId: "req-789",
      action: "issue.created",
      durationMs: 42,
      tags: ["alpha", "beta"],
    };
    logger.info(benignPayload, "benign log");
    const output = writes.join("");
    expect(output).toContain("user-123");
    expect(output).toContain("co-456");
    expect(output).toContain("req-789");
    expect(output).toContain("issue.created");
    expect(output).toContain("alpha");
    // No "[redacted]" should appear — nothing in this payload is sensitive.
    expect(output).not.toContain("[redacted]");
  });
});

describe("instance-invites route — signupUrl no longer logged at info (PR-7)", () => {
  // Source-level guard. The fix at server/src/routes/instance-invites.ts:135-145
  // removed `signupUrl` from the `logger.info(...)` call when emailSender is
  // disabled. We assert the source file does NOT include `signupUrl` as a
  // direct argument to a `logger.info(...)` invocation. This catches future
  // regressions where someone re-adds the leak.
  it("source guard — `signupUrl` is not present in any logger.info({...}) call args in instance-invites.ts", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.resolve(__dirname, "../routes/instance-invites.ts");
    const source = await fs.readFile(filePath, "utf8");

    // Capture every logger.info({ ... }) (single-line or multi-line). Match
    // the open paren up to the matching close-brace + comma + ... + close-paren.
    // Pragmatic regex: greedy enough to catch the call sites but anchored on
    // `logger.info(` to avoid matching unrelated lines.
    const matches = Array.from(
      source.matchAll(/logger\.(?:info|warn|debug)\s*\(\s*\{[\s\S]*?\}/g),
    );
    expect(matches.length).toBeGreaterThan(0); // sanity: there ARE logger calls

    for (const m of matches) {
      const callArgsBlock = m[0];
      // The post-fix call uses `role` and `expiresAt` (and `to`/`error`/`err`
      // for other call sites). It MUST NOT contain `signupUrl` as an
      // argument key.
      expect(
        callArgsBlock,
        `signupUrl found in logger call: ${callArgsBlock.substring(0, 120)}`,
      ).not.toMatch(/\bsignupUrl\b/);
    }
  });
});
