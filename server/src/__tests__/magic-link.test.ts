/**
 * Sprint 6 · S6.7 — magic-link service integration tests.
 *
 * Validates the token lifecycle end-to-end against real Postgres:
 *   1. issue() returns a plaintext token + persists sha256 hash
 *   2. issue() refuses ttlMinutes outside [1, 1440]
 *   3. issue() refuses approve_action without a target ref
 *   4. issue() refuses half-set ref pair (kind set, id null and vice versa)
 *   5. consume() rejects malformed plaintext (wrong format, bad chars)
 *   6. consume() rejects unknown hash (no row leak)
 *   7. consume() succeeds on a fresh token, returns purpose + ref
 *   8. consume() rejects double-consume (single-use enforcement)
 *   9. consume() rejects expired tokens
 *  10. consume() race — two concurrent consumes only one wins (atomic)
 *  11. purgeExpired() deletes only expired-AND-unconsumed; keeps consumed
 *  12. CHECK constraints reject invalid purpose / ref pairs at DB level
 *  13. plaintext is NOT stored anywhere
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companies,
  createDb,
  magicLinkTokens,
} from "@founderos/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  hashMagicLinkToken,
  magicLinkService,
} from "../services/magic-link.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping magic-link tests: ${support.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("magic-link service (S6.7)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof magicLinkService>;
  let companyA: string;
  let userA: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("magic-link");
    db = createDb(testDb.connectionString);
    service = magicLinkService(db);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "magic_link_tokens" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "activity_log" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);

    const ts = Date.now();
    const [c] = await db
      .insert(companies)
      .values({ name: "Acme", slug: `acme-${ts}`, issuePrefix: `ML${ts}A` })
      .returning({ id: companies.id });
    companyA = c.id;

    const now = new Date();
    const [u] = await db
      .insert(authUsers)
      .values({
        id: `user-${ts}`,
        name: "Founder",
        email: `founder-${ts}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: authUsers.id });
    userA = u.id;
  });

  describe("issue()", () => {
    it("returns a plaintext token in the expected format", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      expect(issued.token).toMatch(/^mlt_[A-Za-z0-9_-]{48}$/);
      expect(issued.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("persists sha256 hash, NOT plaintext", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(sql`${magicLinkTokens.id} = ${issued.id}::uuid`);

      expect(row.tokenHash).toBe(hashMagicLinkToken(issued.token));
      expect(row.tokenHash).toHaveLength(64); // sha256 hex
      // Double-check: the plaintext does NOT appear in any column.
      const allColsConcat = JSON.stringify(row);
      expect(allColsConcat).not.toContain(issued.token);
    });

    it("refuses ttlMinutes <= 0", async () => {
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "view_brief",
          ttlMinutes: 0,
        }),
      ).rejects.toThrow(/ttlMinutes/);
    });

    it("refuses ttlMinutes > 1440 (24h spec ceiling)", async () => {
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "view_brief",
          ttlMinutes: 1441,
        }),
      ).rejects.toThrow(/ttlMinutes/);
    });

    it("refuses approve_action without a target ref", async () => {
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "approve_action",
          ttlMinutes: 60,
        }),
      ).rejects.toThrow(/target ref/);
    });

    it("refuses half-set ref pair (kind set, id null)", async () => {
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "approve_action",
          targetRefKind: "approval",
          targetRefId: null,
          ttlMinutes: 60,
        }),
      ).rejects.toThrow(/both set or both null/);
    });

    it("refuses half-set ref pair (id set, kind null)", async () => {
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "view_brief",
          targetRefKind: null,
          targetRefId: "stray-id",
          ttlMinutes: 60,
        }),
      ).rejects.toThrow(/both set or both null/);
    });

    it("accepts approve_action with a complete target ref", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "approve_action",
        targetRefKind: "approval",
        targetRefId: "appr-xyz",
        ttlMinutes: 60,
      });
      expect(issued.token).toMatch(/^mlt_/);
    });
  });

  describe("consume()", () => {
    it("rejects malformed plaintext (no prefix)", async () => {
      const result = await service.consume("not-a-magic-link-at-all");
      expect(result).toBeNull();
    });

    it("rejects malformed plaintext (right prefix, wrong charset)", async () => {
      const result = await service.consume(
        "mlt_!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      );
      expect(result).toBeNull();
    });

    it("rejects plaintext with no matching hash (no row leak)", async () => {
      // Format-valid but never-issued token — should miss the index lookup.
      const result = await service.consume(
        "mlt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
      expect(result).toBeNull();
    });

    it("succeeds on a fresh token; returns purpose + ref", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "approve_action",
        targetRefKind: "approval",
        targetRefId: "appr-ok",
        ttlMinutes: 60,
      });

      const consumed = await service.consume(issued.token);
      expect(consumed).not.toBeNull();
      expect(consumed!.userId).toBe(userA);
      expect(consumed!.companyId).toBe(companyA);
      expect(consumed!.purpose).toBe("approve_action");
      expect(consumed!.targetRefKind).toBe("approval");
      expect(consumed!.targetRefId).toBe("appr-ok");
    });

    it("rejects double-consume (single-use enforcement)", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const first = await service.consume(issued.token);
      expect(first).not.toBeNull();

      const second = await service.consume(issued.token);
      expect(second).toBeNull();
    });

    it("preserves the consumed row (audit trail) — not deleted", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      await service.consume(issued.token, "203.0.113.42");

      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(sql`${magicLinkTokens.id} = ${issued.id}::uuid`);
      expect(row).toBeDefined();
      expect(row.consumedAt).not.toBeNull();
      expect(row.consumedByIp).toBe("203.0.113.42");
    });

    it("rejects expired tokens", async () => {
      // Issue then manually backdate expires_at to the past.
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      await db.execute(sql`
        UPDATE "magic_link_tokens"
        SET expires_at = NOW() - interval '1 minute'
        WHERE id = ${issued.id}::uuid
      `);

      const consumed = await service.consume(issued.token);
      expect(consumed).toBeNull();
    });

    it("two concurrent consumes — only one wins (atomic)", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const [a, b] = await Promise.all([
        service.consume(issued.token),
        service.consume(issued.token),
      ]);

      // Exactly one of them should have a value; the other should be null.
      const successes = [a, b].filter((x) => x !== null);
      expect(successes).toHaveLength(1);
    });
  });

  describe("purgeExpired()", () => {
    it("deletes expired-AND-unconsumed; preserves consumed", async () => {
      // Three tokens:
      //   t1: expired + unconsumed → should be deleted
      //   t2: expired + consumed   → should be PRESERVED (audit)
      //   t3: live + unconsumed    → should be PRESERVED
      const t1 = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      const t2 = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      await service.consume(t2.token);
      const t3 = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      // Backdate t1 + t2 expires_at to the past.
      await db.execute(sql`
        UPDATE "magic_link_tokens"
        SET expires_at = NOW() - interval '1 minute'
        WHERE id IN (${t1.id}::uuid, ${t2.id}::uuid)
      `);

      const purged = await service.purgeExpired();
      expect(purged).toBe(1);

      // t1 deleted, t2 + t3 still present.
      const remaining = await db.select().from(magicLinkTokens);
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(t2.id);
      expect(ids).toContain(t3.id);
      expect(ids).not.toContain(t1.id);
    });
  });

  describe("DB-level CHECK constraints", () => {
    it("rejects invalid purpose values", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "magic_link_tokens"
            ("user_id", "company_id", "token_hash", "purpose", "expires_at")
          VALUES
            (${userA}, ${companyA}::uuid, 'a'::text, 'invalid_purpose', NOW() + interval '1 hour')
        `),
      ).rejects.toThrow();
    });

    it("rejects approve_action without target_ref (CHECK)", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "magic_link_tokens"
            ("user_id", "company_id", "token_hash", "purpose", "expires_at")
          VALUES
            (${userA}, ${companyA}::uuid, 'b'::text, 'approve_action', NOW() + interval '1 hour')
        `),
      ).rejects.toThrow();
    });

    it("rejects half-set target_ref pair (CHECK)", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "magic_link_tokens"
            ("user_id", "company_id", "token_hash", "purpose", "target_ref_kind", "target_ref_id", "expires_at")
          VALUES
            (${userA}, ${companyA}::uuid, 'c'::text, 'view_brief', 'approval', NULL, NOW() + interval '1 hour')
        `),
      ).rejects.toThrow();
    });

    it("rejects duplicate token_hash (UNIQUE)", async () => {
      await db.execute(sql`
        INSERT INTO "magic_link_tokens"
          ("user_id", "company_id", "token_hash", "purpose", "expires_at")
        VALUES
          (${userA}, ${companyA}::uuid, 'collision'::text, 'view_brief', NOW() + interval '1 hour')
      `);
      await expect(
        db.execute(sql`
          INSERT INTO "magic_link_tokens"
            ("user_id", "company_id", "token_hash", "purpose", "expires_at")
          VALUES
            (${userA}, ${companyA}::uuid, 'collision'::text, 'view_brief', NOW() + interval '1 hour')
        `),
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PR-6a (council 2026-05-07 P1-6) — audit log coverage for magic-link
  // issuance + consumption. The token table itself records consumed_at /
  // consumed_by_ip but the audit trail (who, when, against what target)
  // lives in `activity_log`. Pre-fix: zero rows. The audit was supposed
  // to be the source of truth for "who issued / consumed which token,"
  // but neither code path wrote to it.
  //
  // Atomicity invariant: the token op + audit row must commit together.
  // Both `issue()` and `consume()` are wrapped in `db.transaction`, so
  // an audit-insert failure rolls back the underlying token op too.
  // Negative case: failed consumes (bad format, expired, double-consume)
  // do NOT write audit rows — only successful state changes are
  // audited, otherwise the table fills with attempt-noise.
  // ─────────────────────────────────────────────────────────────────────────
  describe("activity_log audit trail (PR-6a)", () => {
    it("issue() writes one activity_log row with action='magic_link.issued' and full target context", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "approve_action",
        targetRefKind: "approval",
        targetRefId: "approval-123",
        ttlMinutes: 30,
      });

      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issued.id));

      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.action).toBe("magic_link.issued");
      expect(r.entityType).toBe("magic_link");
      expect(r.entityId).toBe(issued.id);
      expect(r.companyId).toBe(companyA);
      expect(r.actorId).toBe(userA);
      expect(r.actorType).toBe("user");
      expect(r.details).toMatchObject({
        purpose: "approve_action",
        targetRefKind: "approval",
        targetRefId: "approval-123",
        ttlMinutes: 30,
      });
    });

    it("consume() writes one activity_log row with action='magic_link.consumed' on success", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      // After issue there is exactly one audit row (the issue event).
      const consumed = await service.consume(issued.token, "198.51.100.7");
      expect(consumed).not.toBeNull();

      const rows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issued.id));

      // Exactly two rows now: issued + consumed, in order.
      expect(rows).toHaveLength(2);
      const consumedRow = rows.find((r) => r.action === "magic_link.consumed");
      expect(consumedRow).toBeDefined();
      expect(consumedRow!.entityType).toBe("magic_link");
      expect(consumedRow!.companyId).toBe(companyA);
      expect(consumedRow!.actorId).toBe(userA);
      expect(consumedRow!.actorType).toBe("user");
      expect(consumedRow!.details).toMatchObject({
        purpose: "view_brief",
        consumedByIp: "198.51.100.7",
      });
    });

    it("consume() does NOT write an audit row when the token is rejected (bad format / unknown / double / expired)", async () => {
      // 1. Bad format → null, no audit row.
      const r1 = await service.consume("not-a-valid-token");
      expect(r1).toBeNull();

      // 2. Unknown hash (well-formed but never issued) → null, no audit row.
      const r2 = await service.consume(
        "mlt_" + "A".repeat(48),
      );
      expect(r2).toBeNull();

      // 3. Successful issue + double-consume — only the FIRST consume audits.
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      const first = await service.consume(issued.token);
      expect(first).not.toBeNull();
      const second = await service.consume(issued.token);
      expect(second).toBeNull();

      // After all of the above: only 2 audit rows total
      // (issued + first-consume). The bad / unknown / double-consume
      // attempts left no trace.
      const allRows = await db.select().from(activityLog);
      expect(allRows).toHaveLength(2);
      expect(allRows.map((r) => r.action).sort()).toEqual([
        "magic_link.consumed",
        "magic_link.issued",
      ]);
    });

    it("issue() failure (validation) does NOT write an audit row", async () => {
      // Validation throws synchronously BEFORE the transaction opens, so
      // no token row, no audit row.
      await expect(
        service.issue({
          userId: userA,
          companyId: companyA,
          purpose: "approve_action", // missing target ref → throws
          ttlMinutes: 60,
        }),
      ).rejects.toThrow(/target ref/);

      const rows = await db.select().from(activityLog);
      expect(rows).toHaveLength(0);
    });
  });
});
