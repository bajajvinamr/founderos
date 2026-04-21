/**
 * Company-scoped integrations service.
 *
 * Stores API keys encrypted at rest using the same envelope encryption as
 * instance-api-keys. Keys are never returned to callers — only a hint
 * (last 4 chars) is exposed.
 *
 * One integration per (companyId + kind). Upsert on create so the UI can
 * "reconnect" a previously disconnected integration without a delete first.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations } from "@founderos/db";
import {
  INTEGRATION_KINDS,
  type IntegrationKind,
} from "@founderos/shared";
import {
  encryptWithMasterKey,
  decryptWithMasterKey,
} from "../secrets/local-encrypted-provider.js";
import type { Integration } from "@founderos/shared";

export type CreateIntegrationInput = {
  kind: IntegrationKind;
  apiKey: string;
  config?: Record<string, unknown>;
};

function extractHint(value: string): string {
  if (value.length < 8) return "****";
  return "…" + value.slice(-4);
}

function isValidKind(kind: string): kind is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(kind);
}

function toIntegration(row: typeof integrations.$inferSelect): Integration {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as IntegrationKind,
    status: row.status as Integration["status"],
    keyHint: row.keyHint ?? null,
    config: (row.config as Record<string, unknown>) ?? null,
    lastError: row.lastError ?? null,
    connectedAt: row.connectedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function integrationService(db: Db) {
  /**
   * List all integrations for a company — no encrypted values returned.
   */
  async function list(companyId: string): Promise<Integration[]> {
    const rows = await db
      .select()
      .from(integrations)
      .where(eq(integrations.companyId, companyId));
    return rows.map(toIntegration);
  }

  /**
   * Create or reconnect an integration. Encrypts the API key before storing.
   * Returns the row without the encrypted key.
   */
  async function create(
    companyId: string,
    input: CreateIntegrationInput,
  ): Promise<Integration> {
    if (!isValidKind(input.kind)) {
      throw new Error(`Invalid integration kind: ${input.kind}`);
    }
    const trimmed = input.apiKey.trim();
    if (trimmed.length === 0) {
      throw new Error("API key cannot be empty");
    }

    const encrypted = encryptWithMasterKey(trimmed);
    const hint = extractHint(trimmed);
    const now = new Date();

    const [row] = await db
      .insert(integrations)
      .values({
        companyId,
        kind: input.kind,
        status: "connected",
        keyHint: hint,
        encryptedApiKey: encrypted,
        config: input.config ?? null,
        lastError: null,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [integrations.companyId, integrations.kind],
        set: {
          status: "connected",
          keyHint: hint,
          encryptedApiKey: encrypted,
          config: input.config ?? null,
          lastError: null,
          connectedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return toIntegration(row);
  }

  /**
   * Remove an integration. Returns true if a row was deleted.
   */
  async function remove(companyId: string, id: string): Promise<boolean> {
    const result = await db
      .delete(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.companyId, companyId)))
      .returning();
    return result.length > 0;
  }

  /**
   * Get a single integration by kind (one per company per kind).
   */
  async function getByKind(
    companyId: string,
    kind: IntegrationKind,
  ): Promise<Integration | null> {
    const [row] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.companyId, companyId),
          eq(integrations.kind, kind),
        ),
      );
    return row ? toIntegration(row) : null;
  }

  /**
   * Read + decrypt the API key for server-side use.
   * Returns null if the integration doesn't exist or the key can't be decrypted.
   */
  async function getDecryptedApiKey(
    companyId: string,
    id: string,
  ): Promise<string | null> {
    const [row] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.companyId, companyId)));
    if (!row?.encryptedApiKey) return null;
    try {
      return decryptWithMasterKey(row.encryptedApiKey);
    } catch {
      return null;
    }
  }

  return {
    list,
    create,
    remove,
    getByKind,
    getDecryptedApiKey,
  };
}
