import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Instance-level API keys for AI providers (Anthropic, OpenAI, Gemini).
 *
 * Scope: instance. One instance = one customer in the single-tenant deploy
 * model. A single row per (family + execution_mode) pair; updating an
 * existing family overwrites the ciphertext.
 *
 * Values are encrypted with the local encrypted provider's master key and
 * stored as JSON-serialized material. Decryption happens only inside the
 * server — the value is never returned to clients.
 */
export const instanceApiKeys = pgTable(
  "instance_api_keys",
  {
    id: text("id").primaryKey(),        // Composite slug: `${family}:${executionMode}`
    family: text("family").notNull(),    // "anthropic" | "openai" | "google"
    executionMode: text("execution_mode").notNull(), // "api" | "cli_oauth"
    /** JSON-encoded local_encrypted_v1 envelope (iv/tag/ciphertext). */
    encryptedValue: text("encrypted_value").notNull(),
    /** Optional display hint — last 4 chars of the key for the UI. Never the full value. */
    keyHint: text("key_hint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyModeIdx: uniqueIndex("instance_api_keys_family_mode_idx").on(
      table.family,
      table.executionMode,
    ),
  }),
);
