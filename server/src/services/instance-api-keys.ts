/**
 * Instance-level AI provider API key service.
 *
 * Single-tenant deployment means one instance per customer, so API keys
 * are stored at the instance level (not per-company). Values are encrypted
 * at rest via the local-encrypted master key and never returned raw — the
 * UI only gets a hint (last 4 chars) and a "configured" boolean.
 *
 * Agent-runtime integration: stored keys are synced into the server's own
 * process.env on set / delete / boot. Because adapter subprocesses inherit
 * the parent env, this means every future `claude` / `codex` / `gemini`
 * child process automatically picks up the DB-stored keys with zero
 * per-adapter plumbing. Original process.env values (if any) are stashed
 * at module load so delete can revert cleanly.
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

// ────────────────────────────────────────────────────────────────────────
// process.env bridging.
//
// When a stored key is set, we also populate the server's process.env so
// adapter subprocesses (spawned via Node `child_process` with default env
// inheritance) see the same credential the UI just configured. We stash
// the pre-startup value once so delete can restore it without ambiguity.
// ────────────────────────────────────────────────────────────────────────

const ENV_VAR_BY_FAMILY: Record<ProviderFamilyKey, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

const originalEnv: Record<ProviderFamilyKey, string | undefined> = {
  anthropic: process.env[ENV_VAR_BY_FAMILY.anthropic],
  openai: process.env[ENV_VAR_BY_FAMILY.openai],
  google: process.env[ENV_VAR_BY_FAMILY.google],
};

function applyKeyToEnv(family: ProviderFamilyKey, value: string): void {
  const envVar = ENV_VAR_BY_FAMILY[family];
  process.env[envVar] = value;
}

function restoreOriginalEnv(family: ProviderFamilyKey): void {
  const envVar = ENV_VAR_BY_FAMILY[family];
  const original = originalEnv[family];
  if (typeof original === "string" && original.length > 0) {
    process.env[envVar] = original;
  } else {
    delete process.env[envVar];
  }
}

function extractHint(value: string): string {
  if (value.length < 8) return "****";
  return "…" + value.slice(-4);
}

export function instanceApiKeysService(db: Db) {
  /**
   * Insert or update an API key for the given provider + execution mode.
   * Returns the stored metadata (no decrypted value).
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
    // Sync into process.env so adapter subprocesses inherit the new key.
    if (executionMode === "api") {
      applyKeyToEnv(input.family, trimmed);
    }
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
    if (executionMode === "api" && result.length > 0) {
      restoreOriginalEnv(family);
    }
    return result.length > 0;
  }

  /**
   * Boot hook — load every stored API key and push it into process.env so
   * adapter subprocesses pick them up. Call once during server startup.
   */
  async function hydrateProcessEnv(): Promise<number> {
    const rows = await db.select().from(instanceApiKeys);
    let loaded = 0;
    for (const row of rows) {
      if (row.executionMode !== "api") continue;
      if (!isSupportedFamily(row.family)) continue;
      try {
        const decrypted = decryptWithMasterKey(row.encryptedValue);
        applyKeyToEnv(row.family, decrypted);
        loaded++;
      } catch {
        // Skip — master key rotated or envelope corrupt. The UI will show
        // the row as "configured" but agents won't see the env var,
        // which is the safest failure mode.
      }
    }
    return loaded;
  }

  /**
   * Read + decrypt a stored key for server-side use (e.g., spawning an
   * adapter subprocess with the credential in env). Returns null if no
   * such key is configured.
   */
  async function getDecryptedKey(
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
    getDecryptedKey,
    listConfiguredFamilies,
    hydrateProcessEnv,
  };
}

function isSupportedFamily(f: string): f is ProviderFamilyKey {
  return f === "anthropic" || f === "openai" || f === "google";
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
