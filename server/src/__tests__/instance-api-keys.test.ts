/**
 * instance-api-keys.test.ts — encryption helpers + service behavior.
 *
 * Service tests (S8 P0.1 Phase 1B, council R1 condition C2):
 *   - setKey() does NOT mutate process.env
 *   - getDecrypted() returns the stored plaintext
 *   - deleteKey() then getDecrypted() returns null
 *   - 5 concurrent setKey calls don't corrupt the encrypted blob (final
 *     read returns the last-written value, no exception)
 *   - Decrypted plaintext is NEVER passed to a logger arg
 *
 * The service tests use embedded Postgres (gated when unsupported); the
 * encryption-helper tests run unconditionally — they don't touch the DB.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@founderos/db";
import {
  encryptWithMasterKey,
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceApiKeysService } from "../services/instance-api-keys.js";

// Set a deterministic master key for the test suite so encryption
// round-trips are reproducible. Must run before the helpers are called.
beforeEach(() => {
  process.env.FOUNDEROS_SECRETS_MASTER_KEY =
    "A".repeat(43) + "=";
});

describe("encryptWithMasterKey / decryptWithMasterKey", () => {
  it("round-trips a short string", () => {
    const encrypted = encryptWithMasterKey("hello world");
    expect(encrypted).not.toContain("hello");
    expect(decryptWithMasterKey(encrypted)).toBe("hello world");
  });

  it("round-trips an API-key-shaped string", () => {
    const key = "sk-ant-api03-" + "x".repeat(95);
    const encrypted = encryptWithMasterKey(key);
    expect(decryptWithMasterKey(encrypted)).toBe(key);
  });

  it("produces different ciphertext for the same plaintext (IV randomized)", () => {
    const a = encryptWithMasterKey("same");
    const b = encryptWithMasterKey("same");
    expect(a).not.toBe(b);
    expect(decryptWithMasterKey(a)).toBe("same");
    expect(decryptWithMasterKey(b)).toBe("same");
  });

  it("envelope JSON contains the expected scheme tag", () => {
    const encrypted = encryptWithMasterKey("tag-me");
    const parsed = JSON.parse(encrypted) as { scheme: string; iv: string; tag: string; ciphertext: string };
    expect(parsed.scheme).toBe("local_encrypted_v1");
    expect(parsed.iv.length).toBeGreaterThan(0);
    expect(parsed.tag.length).toBeGreaterThan(0);
    expect(parsed.ciphertext.length).toBeGreaterThan(0);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptWithMasterKey("don't touch");
    const parsed = JSON.parse(encrypted) as { ciphertext: string };
    // Flip a byte in the ciphertext → AEAD tag should reject
    const tampered = JSON.stringify({
      ...parsed,
      ciphertext: "A" + parsed.ciphertext.slice(1),
    });
    expect(() => decryptWithMasterKey(tampered)).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Hint extraction — used in the UI to show users a safe confirmation
// that their key was saved. We duplicate the logic here; the service file
// keeps the real implementation private.
// ──────────────────────────────────────────────────────────────────────
function extractHint(value: string): string {
  if (value.length < 8) return "****";
  return "…" + value.slice(-4);
}

describe("key hint extraction", () => {
  it("returns **** for very short strings", () => {
    expect(extractHint("")).toBe("****");
    expect(extractHint("abc")).toBe("****");
    expect(extractHint("abc1234")).toBe("****"); // length 7
  });

  it("returns last 4 chars prefixed with ellipsis for normal keys", () => {
    expect(extractHint("sk-ant-xyz1234")).toBe("…1234");
    expect(extractHint("sk-ant-api03-" + "a".repeat(99))).toMatch(/…a{4}/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Service tests — round-trip + no-process.env-mutation invariants.
// These exercise the post-Phase-1B contract: setKey persists encrypted,
// getDecrypted returns plaintext, and process.env is NEVER touched.
// ──────────────────────────────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping instance-api-keys service tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("instanceApiKeysService — per-call key vault (no env mutation)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("inst-api-keys");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    // Clean slate — drop any rows from prior tests so concurrent / sequential
    // expectations are deterministic.
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`delete from instance_api_keys`,
    );
  });

  it("setKey does NOT mutate process.env.ANTHROPIC_API_KEY", async () => {
    // Capture pre-call value so we can assert exact unchanged.
    const before = process.env.ANTHROPIC_API_KEY;
    const svc = instanceApiKeysService(db);

    await svc.setKey({
      family: "anthropic",
      executionMode: "api",
      value: "sk-ant-test-no-env-mutation-12345",
    });

    expect(process.env.ANTHROPIC_API_KEY).toBe(before);
  });

  it("setKey for openai does NOT mutate process.env.OPENAI_API_KEY", async () => {
    const before = process.env.OPENAI_API_KEY;
    const svc = instanceApiKeysService(db);

    await svc.setKey({
      family: "openai",
      executionMode: "api",
      value: "sk-openai-test-67890",
    });

    expect(process.env.OPENAI_API_KEY).toBe(before);
  });

  it("setKey for google does NOT mutate process.env.GEMINI_API_KEY", async () => {
    const before = process.env.GEMINI_API_KEY;
    const svc = instanceApiKeysService(db);

    await svc.setKey({
      family: "google",
      executionMode: "api",
      value: "AIza-google-test-abcdef",
    });

    expect(process.env.GEMINI_API_KEY).toBe(before);
  });

  it("getDecrypted returns the plaintext stored by setKey", async () => {
    const svc = instanceApiKeysService(db);
    const value = "sk-ant-test-roundtrip-xyz";

    await svc.setKey({
      family: "anthropic",
      executionMode: "api",
      value,
    });

    const out = await svc.getDecrypted("anthropic", "api");
    expect(out).toBe(value);
  });

  it("getDecrypted returns null after deleteKey", async () => {
    const svc = instanceApiKeysService(db);

    await svc.setKey({
      family: "anthropic",
      executionMode: "api",
      value: "sk-ant-test-for-deletion",
    });

    const ok = await svc.deleteKey("anthropic", "api");
    expect(ok).toBe(true);

    const out = await svc.getDecrypted("anthropic", "api");
    expect(out).toBeNull();
  });

  it("getDecrypted returns null when no key configured for any family", async () => {
    const svc = instanceApiKeysService(db);
    expect(await svc.getDecrypted("anthropic", "api")).toBeNull();
    expect(await svc.getDecrypted("openai", "api")).toBeNull();
    expect(await svc.getDecrypted("google", "api")).toBeNull();
  });

  it("deleteKey does NOT touch process.env (no restoreOriginalEnv leak)", async () => {
    const svc = instanceApiKeysService(db);

    await svc.setKey({
      family: "anthropic",
      executionMode: "api",
      value: "sk-ant-delete-doesnt-mutate",
    });

    const before = process.env.ANTHROPIC_API_KEY;
    await svc.deleteKey("anthropic", "api");
    expect(process.env.ANTHROPIC_API_KEY).toBe(before);
  });

  it("5 concurrent setKey calls converge to a coherent stored value (no corruption)", async () => {
    const svc = instanceApiKeysService(db);
    const values = [
      "sk-ant-concurrent-1",
      "sk-ant-concurrent-2",
      "sk-ant-concurrent-3",
      "sk-ant-concurrent-4",
      "sk-ant-concurrent-5",
    ];

    // Fire 5 in parallel and don't crash. The DB upsert-on-conflict means
    // exactly one of these is the "last writer"; we only assert that
    // (a) no exception is thrown and (b) the final read returns ONE of the
    // submitted values (not garbled / partial / corrupted).
    await expect(
      Promise.all(
        values.map((value) =>
          svc.setKey({ family: "anthropic", executionMode: "api", value }),
        ),
      ),
    ).resolves.toBeDefined();

    const out = await svc.getDecrypted("anthropic", "api");
    expect(out).not.toBeNull();
    expect(values).toContain(out);
  });

  it("getDecrypted does NOT log the plaintext (log spy assertion)", async () => {
    const svc = instanceApiKeysService(db);
    const plaintext = "sk-ant-secret-must-never-appear-in-logs-7c1f9b";

    await svc.setKey({
      family: "anthropic",
      executionMode: "api",
      value: plaintext,
    });

    // Spy on EVERY console method to catch a stray log call. We don't have
    // a structured logger injected here so process-wide stdio is the
    // boundary to assert.
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];

    try {
      const out = await svc.getDecrypted("anthropic", "api");
      expect(out).toBe(plaintext);

      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            const serialized =
              typeof arg === "string" ? arg : JSON.stringify(arg);
            expect(serialized).not.toContain(plaintext);
          }
        }
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("getDecryptedKey is a deprecated alias that resolves to the same value as getDecrypted", async () => {
    const svc = instanceApiKeysService(db);
    const value = "sk-ant-alias-check-deadbeef";

    await svc.setKey({ family: "anthropic", executionMode: "api", value });

    const a = await svc.getDecrypted("anthropic", "api");
    const b = await svc.getDecryptedKey("anthropic", "api");
    expect(a).toBe(value);
    expect(b).toBe(value);
  });
});
