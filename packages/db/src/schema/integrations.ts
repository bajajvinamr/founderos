import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Company-scoped external tool integrations.
 *
 * Each integration row represents a single third-party connection (PostHog,
 * HubSpot, Slack, Notion, LinkedIn). API keys are stored encrypted and are
 * never returned to clients — only the key hint (last 4 chars) is exposed.
 *
 * One integration per (companyId + kind) enforced by unique index.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    /** Integration type — posthog | hubspot | slack | notion | linkedin */
    kind: text("kind").notNull(),
    /** Connection state — connected | error | disconnected */
    status: text("status").notNull().default("disconnected"),
    /** Last 4 chars of the API key for UI display. Never the full key. */
    keyHint: text("key_hint"),
    /**
     * JSON-encoded local_encrypted_v1 envelope (iv/tag/ciphertext).
     * Never returned to clients.
     */
    encryptedApiKey: text("encrypted_api_key"),
    /** Opaque per-integration config (workspace IDs, account IDs, etc.). */
    config: jsonb("config").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindUniqueIdx: uniqueIndex("integrations_company_kind_idx").on(
      table.companyId,
      table.kind,
    ),
  }),
);
