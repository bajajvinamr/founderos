/**
 * Sprint 6 · S6.7 — magic-link service.
 *
 * Short-lived single-use auth tokens for the mobile daily brief flow.
 *
 * Threat model:
 *   - T1 (token leak in DB dump): sha256-only at rest; plaintext is
 *     returned exactly once at issue time. A leaked DB dump cannot be
 *     replayed against the auth path.
 *   - T2 (timing oracle on hash compare): constant-time compare via
 *     `timingSafeEqual` after length-equality (length difference returns
 *     false without leaking timing).
 *   - T3 (token replay): single-use via `consumed_at` — once set, the
 *     token cannot re-auth. We keep the row instead of DELETE so the
 *     audit trail (who consumed when, from which IP) is preserved.
 *   - T4 (TTL drift): `expires_at` is NOT NULL at the DB level; service
 *     enforces `ttlMinutes <= 1440` (24h spec ceiling).
 *   - T5 (purpose confusion): a `view_brief` token cannot consume an
 *     `approve_action` route — `consume()` returns the purpose so the
 *     caller can route correctly, and the service refuses to issue an
 *     `approve_action` without a target ref.
 *
 * Mirrors `runner-auth.ts` security shape — both produce sha256 hex,
 * length-validated, timing-safe compared.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  activityLog,
  magicLinkTokens,
  type MagicLinkPurpose,
  type MagicLinkTargetRefKind,
} from "@founderos/db";

/**
 * Plaintext token format: `mlt_<48 url-safe alnum>`. 48 chars × ~6 bits each
 * = ~288 bits of entropy, well above the 128-bit floor for short-lived
 * single-use auth. Format prefix `mlt_` makes leaks visually distinct from
 * runner tokens (`fos_`) and is the regex the issuer validates against.
 */
const TOKEN_PREFIX = "mlt_";
const TOKEN_BODY_LEN = 48;
const TOKEN_FORMAT = /^mlt_[A-Za-z0-9_-]{48}$/;
const SHA256_HEX_LEN = 64;

/** 24h spec ceiling — service-layer guard backstops the DB NOT NULL. */
const MAX_TTL_MINUTES = 24 * 60;

export interface IssueMagicLinkParams {
  userId: string;
  companyId: string;
  purpose: MagicLinkPurpose;
  targetRefKind?: MagicLinkTargetRefKind | null;
  targetRefId?: string | null;
  ttlMinutes: number;
}

export interface IssuedMagicLink {
  /** Plaintext — return this to the caller ONCE; never log or persist. */
  token: string;
  id: string;
  expiresAt: Date;
}

export interface ConsumedMagicLink {
  id: string;
  userId: string;
  companyId: string;
  purpose: MagicLinkPurpose;
  targetRefKind: MagicLinkTargetRefKind | null;
  targetRefId: string | null;
}

/**
 * Generate a fresh random plaintext token. Returns `mlt_<48 url-safe alnum>`.
 * 36 random bytes → base64url (no padding) → first 48 chars. Each call
 * draws fresh entropy from `randomBytes`.
 */
function generatePlaintext(): string {
  // 36 bytes b64url-encodes to 48 chars (no padding).
  return TOKEN_PREFIX + randomBytes(36).toString("base64url");
}

export function hashMagicLinkToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Constant-time hex compare. Both inputs MUST be the same length
 * (sha256 hex = 64 chars). Length-mismatch shortcircuit avoids leaking
 * "wrong length" vs "wrong hash" through timing.
 */
function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length !== SHA256_HEX_LEN) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function magicLinkService(db: Db) {
  /**
   * Issue a new magic-link token. Returns plaintext + metadata.
   *
   * Plaintext is returned exactly once — the caller (e.g. email send job)
   * is the only consumer. Never log it; never persist it; never round-trip
   * it through anything that retains a copy.
   */
  async function issue(
    params: IssueMagicLinkParams,
  ): Promise<IssuedMagicLink> {
    if (params.ttlMinutes <= 0 || params.ttlMinutes > MAX_TTL_MINUTES) {
      throw new Error(
        `ttlMinutes must be between 1 and ${MAX_TTL_MINUTES} (24h)`,
      );
    }

    const refKindSet = params.targetRefKind != null;
    const refIdSet =
      params.targetRefId != null && params.targetRefId !== "";
    if (refKindSet !== refIdSet) {
      throw new Error("targetRefKind and targetRefId must be both set or both null");
    }

    if (params.purpose === "approve_action" && !refKindSet) {
      throw new Error(
        "approve_action tokens MUST carry a target ref (e.g. approval id)",
      );
    }

    const plaintext = generatePlaintext();
    const tokenHash = hashMagicLinkToken(plaintext);
    const expiresAt = new Date(Date.now() + params.ttlMinutes * 60_000);

    // PR-6a (council 2026-05-07): wrap token insert + audit-log row in
    // one transaction so either both commit or both roll back. An audit
    // gap on a successful issue would mean a token exists in the wild
    // with no record of who created it — exactly the silent failure
    // mode this audit closes.
    const row = await db.transaction(async (tx) => {
      const [tokenRow] = await tx
        .insert(magicLinkTokens)
        .values({
          userId: params.userId,
          companyId: params.companyId,
          tokenHash,
          purpose: params.purpose,
          targetRefKind: params.targetRefKind ?? null,
          targetRefId: params.targetRefId ?? null,
          expiresAt,
        })
        .returning({
          id: magicLinkTokens.id,
          expiresAt: magicLinkTokens.expiresAt,
        });

      await tx.insert(activityLog).values({
        companyId: params.companyId,
        actorType: "user",
        actorId: params.userId,
        action: "magic_link.issued",
        entityType: "magic_link",
        entityId: tokenRow.id,
        details: {
          purpose: params.purpose,
          targetRefKind: params.targetRefKind ?? null,
          targetRefId: params.targetRefId ?? null,
          ttlMinutes: params.ttlMinutes,
          expiresAt: tokenRow.expiresAt.toISOString(),
        },
      });

      return tokenRow;
    });

    return { token: plaintext, id: row.id, expiresAt: row.expiresAt };
  }

  /**
   * Consume a plaintext token. Returns the resolved (userId, companyId,
   * purpose, ref) on success, or null on any failure mode (bad format,
   * unknown hash, expired, already-consumed). Failures are not
   * distinguished externally — the caller returns 401 either way.
   *
   * Atomicity: the consume is a conditional UPDATE
   *   SET consumed_at = now()
   *   WHERE token_hash = $1
   *     AND consumed_at IS NULL
   *     AND expires_at > now()
   * — so two concurrent consumes for the same token both fail the second
   * one (UPDATE returns 0 rows). No race.
   */
  async function consume(
    plaintext: string,
    consumedByIp?: string | null,
  ): Promise<ConsumedMagicLink | null> {
    if (typeof plaintext !== "string" || !TOKEN_FORMAT.test(plaintext)) {
      return null;
    }

    const tokenHash = hashMagicLinkToken(plaintext);

    // PR-6a (council 2026-05-07): wrap candidate-read + atomic claim +
    // audit-log row in one transaction. Successful consumes get an
    // audit row; failures (bad format, unknown hash, expired,
    // double-consume) do NOT — only state changes are audited so the
    // table doesn't fill with attempt-noise.
    return await db.transaction(async (tx) => {
      // Read first to surface what we'd consume (for the timing-safe
      // re-verify), then conditional update. The conditional is the
      // atomic claim — read-then-update would be a TOCTOU window.
      const [candidate] = await tx
        .select()
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.tokenHash, tokenHash))
        .limit(1);

      if (!candidate) return null;

      // Defense-in-depth re-verify hash matches (DB lookup already filtered
      // but we constant-time check the returned hash to guard against any
      // hypothetical SQL-layer mistake or middleware reordering — same
      // pattern as runner-auth.ts:80).
      if (!safeHashEquals(candidate.tokenHash, tokenHash)) return null;

      // Atomic single-use claim. UPDATE returns the row only if it was
      // unconsumed AND unexpired at the moment of the update.
      const claimed = await tx
        .update(magicLinkTokens)
        .set({ consumedAt: new Date(), consumedByIp: consumedByIp ?? null })
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.consumedAt),
            sql`${magicLinkTokens.expiresAt} > NOW()`,
          ),
        )
        .returning({
          id: magicLinkTokens.id,
          userId: magicLinkTokens.userId,
          companyId: magicLinkTokens.companyId,
          purpose: magicLinkTokens.purpose,
          targetRefKind: magicLinkTokens.targetRefKind,
          targetRefId: magicLinkTokens.targetRefId,
        });

      if (claimed.length === 0) return null;
      const r = claimed[0];

      await tx.insert(activityLog).values({
        companyId: r.companyId,
        actorType: "user",
        actorId: r.userId,
        action: "magic_link.consumed",
        entityType: "magic_link",
        entityId: r.id,
        details: {
          purpose: r.purpose,
          targetRefKind: r.targetRefKind,
          targetRefId: r.targetRefId,
          consumedByIp: consumedByIp ?? null,
        },
      });

      return {
        id: r.id,
        userId: r.userId,
        companyId: r.companyId,
        purpose: r.purpose as MagicLinkPurpose,
        targetRefKind: r.targetRefKind as MagicLinkTargetRefKind | null,
        targetRefId: r.targetRefId,
      };
    });
  }

  /**
   * Sweep expired-but-unconsumed tokens. Returns the count deleted.
   *
   * Consumed tokens are kept — their `consumed_at` row is forensic. Only
   * unconsumed-and-expired rows are removed (they're useless and the row
   * count grows linearly with email sends without this).
   */
  async function purgeExpired(): Promise<number> {
    const result = await db
      .delete(magicLinkTokens)
      .where(
        and(
          isNull(magicLinkTokens.consumedAt),
          lte(magicLinkTokens.expiresAt, new Date()),
        ),
      )
      .returning({ id: magicLinkTokens.id });
    return result.length;
  }

  return { issue, consume, purgeExpired };
}
