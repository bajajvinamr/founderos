/**
 * Instance-level AI provider API key service.
 *
 * Single-tenant deployment means one instance per customer, so API keys
 * are stored at the instance level (not per-company). Values are encrypted
 * at rest via the local-encrypted master key and never returned raw — the
 * UI only gets a hint (last 4 chars) and a "configured" boolean.
 *
 * Per-call resolution model (S8 P0.1 Phase 1B, council R1 condition C2):
 * stored keys are NEVER mirrored into `process.env`. Callers that need the
 * decrypted value at spawn time MUST call `getDecrypted(family, mode)` and
 * inject the credential into the per-spawn child env. The previous
 * "hydrate process.env at boot + on every setKey" pattern was a per-tenant
 * collision risk: when Tenant A's key was set, then Tenant B's key was set,
 * an in-flight job on Tenant A's path would read Tenant B's key from the
 * shared process-wide global. Codex flagged it as per-tenant collision;
 * Gemini independently flagged the same surface as a write race. Both
 * findings are addressed by removing the global mutation surface entirely.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { instanceApiKeys } from "@founderos/db";
import {
  encryptWithMasterKey,
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";

export type ProviderFamilyKey = "anthropic" | "openai" | "google";
export type ExecutionMode = "api" | "cli_oauth";

export type StoredApiKey = {
  family: ProviderFamilyKey;
  executionMode: ExecutionMode;
  keyHint: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function rowId(family: ProviderFamilyKey, mode: ExecutionMode): string {
  return `${family}:${mode}`;
}

function extractHint(value: string): string {
  if (value.length < 8) return "****";
  return "…" + value.slice(-4);
}

export function instanceApiKeysService(db: Db) {
  /**
   * Insert or update an API key for the given provider + execution mode.
   * Returns the stored metadata (no decrypted value). Storage is to the
   * encrypted DB only — process.env is NEVER mutated.
   */
  async function setKey(input: {
    family: ProviderFamilyKey;
    executionMode?: ExecutionMode;
    value: string;
  }): Promise<StoredApiKey> {
    const trimmed = input.value.trim();
    if (trimmed.length === 0) {
      throw new Error("API key value cannot be empty");
    }
    const executionMode = input.executionMode ?? "api";
    const encrypted = encryptWithMasterKey(trimmed);
    const hint = extractHint(trimmed);
    const id = rowId(input.family, executionMode);
    const now = new Date();

    const [row] = await db
      .insert(instanceApiKeys)
      .values({
        id,
        family: input.family,
        executionMode,
        encryptedValue: encrypted,
        keyHint: hint,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: instanceApiKeys.id,
        set: {
          encryptedValue: encrypted,
          keyHint: hint,
          updatedAt: now,
        },
      })
      .returning();
    return toStoredApiKey(row);
  }

  async function listKeys(): Promise<StoredApiKey[]> {
    const rows = await db.select().from(instanceApiKeys);
    return rows.map(toStoredApiKey);
  }

  async function deleteKey(
    family: ProviderFamilyKey,
    executionMode: ExecutionMode = "api",
  ): Promise<boolean> {
    const id = rowId(family, executionMode);
    const result = await db.delete(instanceApiKeys).where(eq(instanceApiKeys.id, id)).returning();
    return result.length > 0;
  }

  /**
   * Read + decrypt a stored key for server-side use at spawn time. Returns
   * the plaintext or null if no such key is configured (or decryption fails
   * — typically a master-key rotation leaving the envelope orphaned).
   *
   * This is the authoritative path for per-call key resolution. Consumers
   * MUST call this immediately before injecting the credential into a child
   * subprocess env or HTTP Authorization header — the value MUST NOT be
   * cached in module-level state, written to logs, or stashed in shared
   * globals. The whole point of moving away from `process.env` mutation is
   * eliminating any process-wide leak surface.
   *
   * Side-channel notes:
   *   - DB lookup is performed unconditionally for every supported family.
   *     Branching off "is this family supported?" before the DB call would
   *     leak family-existence to a timing observer.
   *   - Plaintext is never logged. Failures (no row, decrypt error) all
   *     resolve to `null` with no log line — consumers decide how to surface
   *     the absence to the user without leaking the cause.
   */
  async function getDecrypted(
    family: ProviderFamilyKey,
    executionMode: ExecutionMode = "api",
  ): Promise<string | null> {
    const id = rowId(family, executionMode);
    const [row] = await db.select().from(instanceApiKeys).where(eq(instanceApiKeys.id, id));
    if (!row) return null;
    try {
      return decryptWithMasterKey(row.encryptedValue);
    } catch {
      return null;
    }
  }

  /**
   * Deprecated alias for `getDecrypted`. Existing call sites can migrate
   * lazily; new code MUST call `getDecrypted` directly. Functionally
   * identical; kept only to avoid a wide consumer churn in this PR.
   */
  async function getDecryptedKey(
    family: ProviderFamilyKey,
    executionMode: ExecutionMode = "api",
  ): Promise<string | null> {
    return getDecrypted(family, executionMode);
  }

  /**
   * Returns a map of family → true when an API key is stored. Fast path
   * for provider availability detection — avoids touching the encrypted
   * payload.
   */
  async function listConfiguredFamilies(): Promise<Set<ProviderFamilyKey>> {
    const rows = await db
      .select({ family: instanceApiKeys.family })
      .from(instanceApiKeys);
    const out = new Set<ProviderFamilyKey>();
    for (const row of rows) {
      if (row.family === "anthropic" || row.family === "openai" || row.family === "google") {
        out.add(row.family);
      }
    }
    return out;
  }

  return {
    setKey,
    listKeys,
    deleteKey,
    getDecrypted,
    getDecryptedKey,
    listConfiguredFamilies,
  };
}

function toStoredApiKey(row: typeof instanceApiKeys.$inferSelect): StoredApiKey {
  return {
    family: row.family as ProviderFamilyKey,
    executionMode: row.executionMode as ExecutionMode,
    keyHint: row.keyHint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
