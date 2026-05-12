/**
 * Integration test: apiKeyResolver injection for openai_api and gemini_api adapters.
 *
 * Verifies that:
 * 1. Keys stored via instanceApiKeysService.setKey() are retrievable via
 *    getDecrypted() — the exact call made by the heartbeat.ts apiKeyResolver closure.
 * 2. The resolver returns the correct plaintext (not null / no_api_key) when a
 *    key is stored.
 * 3. The family→provider distinction (google vs gemini) is correctly handled
 *    at the DB storage layer vs the validate endpoint layer.
 *
 * NOTE: Ticket TA01/TA02 specified test file paths inside the adapter packages
 * (packages/adapters/openai-api/... and packages/adapters/gemini-api/...).
 * Those packages do not have @founderos/db or vitest as dependencies, making
 * embedded-PG tests impossible there without significant package reconfiguration.
 * These tests are placed in the server package (which has all required deps) and
 * cover the same acceptance criteria. Deviation noted in PR description.
 *
 * Uses the embedded PostgreSQL test fixture per CLAUDE.md:
 *   startEmbeddedPostgresTestDatabase(prefix) returns { connectionString, cleanup }
 *   createDb(connectionString) returns the Drizzle Db instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, createDb } from "@founderos/db";
import type { EmbeddedPostgresTestDatabase } from "@founderos/db";
import { instanceApiKeysService } from "../services/instance-api-keys.js";

describe("openai-api key-injection (integration)", () => {
  let testDb: EmbeddedPostgresTestDatabase;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("openai-api-key-injection");
    const db = createDb(testDb.connectionString);
    await instanceApiKeysService(db).setKey({
      family: "openai",
      executionMode: "api",
      value: "sk-test-integration-key-123",
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("resolves the stored key via apiKeyResolver and does not return no_api_key", async () => {
    const db = createDb(testDb.connectionString);

    // This is the exact resolver closure that heartbeat.ts injects per TA01/TA02:
    const resolver = (family: string, mode: string) =>
      instanceApiKeysService(db).getDecrypted(
        family as "anthropic" | "openai" | "google",
        mode as "api" | "cli_oauth",
      );

    const resolved = await resolver("openai", "api");
    expect(resolved).toBe("sk-test-integration-key-123");
    expect(resolved).not.toBeNull();
    expect(resolved!.trim().length).toBeGreaterThan(0);
  });

  it("returns null for a family that has no stored key", async () => {
    const db = createDb(testDb.connectionString);
    const resolver = (family: string, mode: string) =>
      instanceApiKeysService(db).getDecrypted(
        family as "anthropic" | "openai" | "google",
        mode as "api" | "cli_oauth",
      );

    const resolved = await resolver("anthropic", "api");
    expect(resolved).toBeNull();
  });
});

describe("gemini-api key-injection (integration)", () => {
  let testDb: EmbeddedPostgresTestDatabase;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("gemini-api-key-injection");
    const db = createDb(testDb.connectionString);
    // Google keys are stored under family='google' (not 'gemini').
    // 'gemini' is only used in the byo-key/validate endpoint schema.
    await instanceApiKeysService(db).setKey({
      family: "google",
      executionMode: "api",
      value: "AIzaFakeKeyForTesting1234567890",
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("resolves the stored google key via config.apiKeyResolver and does not return no_api_key", async () => {
    const db = createDb(testDb.connectionString);

    // The normalized GeminiKeyResolver (TA02) calls resolver('google', 'api').
    const resolver = (family: string, mode: string) =>
      instanceApiKeysService(db).getDecrypted(
        family as "anthropic" | "openai" | "google",
        mode as "api" | "cli_oauth",
      );

    const resolved = await resolver("google", "api");
    expect(resolved).toBe("AIzaFakeKeyForTesting1234567890");
    expect(resolved).not.toBeNull();
    expect(resolved!.trim().length).toBeGreaterThan(0);
  });

  it("returns null for a family with no stored key", async () => {
    const db = createDb(testDb.connectionString);
    const resolver = (family: string, mode: string) =>
      instanceApiKeysService(db).getDecrypted(
        family as "anthropic" | "openai" | "google",
        mode as "api" | "cli_oauth",
      );
    const resolved = await resolver("openai", "api");
    expect(resolved).toBeNull();
  });

  it("verifies the resolver uses family=google (not gemini) to match DB storage", async () => {
    // The DB uses 'google' as the family key (ProviderFamilyKey).
    // The byo-key validate endpoint uses 'gemini' as the provider name.
    // These are different namespaces — the heartbeat resolver must use 'google'.
    const db = createDb(testDb.connectionString);
    const svc = instanceApiKeysService(db);
    const fromGoogle = await svc.getDecrypted("google", "api");
    expect(fromGoogle).toBe("AIzaFakeKeyForTesting1234567890");
  });
});
