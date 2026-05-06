/**
 * Sprint 6 · S6.7 — magic-link tokens.
 *
 * Short-lived single-use auth tokens for the mobile daily brief flow:
 *   - purpose='view_brief'      — sign in to read-only /brief view
 *   - purpose='approve_action'  — one-tap approve a specific approval row
 *
 * Same security pattern as runner tokens (see runner-auth.ts):
 *   - sha256 hex at rest, plaintext shown ONCE at issue time
 *   - constant-time compare on lookup
 *   - 24h max TTL enforced by service-layer guard + DB NOT NULL
 *   - single-use via consumed_at (not DELETE — audit trail preserved)
 */

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const MAGIC_LINK_PURPOSES = ["view_brief", "approve_action"] as const;
export type MagicLinkPurpose = (typeof MAGIC_LINK_PURPOSES)[number];

/**
 * Closed set for the polymorphic ref. Mirror of the CHECK constraint on
 * `magic_link_tokens.target_ref_kind` in migration 0101.
 */
export const MAGIC_LINK_TARGET_REF_KINDS = ["approval"] as const;
export type MagicLinkTargetRefKind =
  (typeof MAGIC_LINK_TARGET_REF_KINDS)[number];

export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** user.id is text (Better-Auth) — same as runner_tokens.created_by_user_id. */
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** sha256 hex of plaintext. Plaintext is NEVER stored — see service. */
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").$type<MagicLinkPurpose>().notNull(),
    targetRefKind: text("target_ref_kind").$type<MagicLinkTargetRefKind | null>(),
    targetRefId: text("target_ref_id"),
    /** null = unconsumed; once set, the token cannot re-auth. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** Forensic: who consumed it. Null until consumed; set on first auth. */
    consumedByIp: text("consumed_by_ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Auth lookup path. UNIQUE prevents collisions + serves as the only access path. */
    tokenHashUniqueIdx: uniqueIndex("magic_link_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
    /** Cleanup-cron query: "find expired but unconsumed". */
    unconsumedExpiresIdx: index(
      "idx_magic_link_tokens_unconsumed_expires",
    ).on(table.expiresAt),
    /** Per-user audit trail. */
    userCreatedIdx: index("idx_magic_link_tokens_user_created").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
