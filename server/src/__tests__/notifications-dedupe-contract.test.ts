/**
 * L2-D27 — Notifications dedupe + cross-user isolation contract.
 *
 * STRUCTURAL TEST. Codifies the S6.6 invariant (2026-05-06) so future
 * regressions trip CI instead of leaking to prod.
 *
 * Vinamr-invariant being defended:
 *
 *   "Notifications dedupe on `(user_id, kind, ref_kind, ref_id)` while
 *   `read_at IS NULL`. Calling `create()` twice with the same target is a
 *   no-op — it returns the existing unread row. Once read, a new identical
 *   notification CAN be created (intentional: re-fire after acknowledgement).
 *   `markRead` is tenant + user scoped; cross-user mark-read returns 404
 *   (NOT 403) to prevent notification-ID enumeration. Pair-invariant CHECK
 *   `((ref_kind IS NULL) = (ref_id IS NULL))` enforces 'both null or both
 *   set' at the DB."
 *
 * Two specific regression risks this test exists to catch:
 *
 *   A. Dedupe relaxation — if the partial-unique constraint
 *      `uniq_notifications_unread_dedup` is dropped or its WHERE clause is
 *      weakened, an inbox will flood with duplicate notifications every
 *      time an upstream event re-fires (approvals, insights, workflow
 *      completions). Same problem at the service layer if `create()` stops
 *      returning the existing row on conflict.
 *
 *   B. Cross-user enumeration — if `markRead` returns 403 instead of 404
 *      on a notification ID owned by another user (a well-intentioned
 *      "more specific error"), an attacker can enumerate which IDs exist
 *      across users (403 = exists-but-not-yours; 404 = doesn't-exist). The
 *      contract is: 404 for BOTH cases, so the attacker can't distinguish.
 *
 * Sibling integration coverage already exists in `notifications.test.ts`.
 * THIS file is a narrowly-focused contract assertion — short, single-purpose,
 * cheap to read in 30 seconds when a future PR makes the index look
 * "redundant" or proposes 403 as a clearer status code.
 */

import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  authUsers,
  companies,
  createDb,
  notifications,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { notificationsService } from "../services/notifications.js";
import { notificationRoutes } from "../routes/notifications.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping notifications-dedupe-contract tests: ${
      support.reason ?? "unsupported"
    }`,
  );
}

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).actor = {
      type: "board",
      userId: "00000000-0000-0000-0000-000000000001",
      companyIds: ["__placeholder__"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use(notificationRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("notifications dedupe + isolation contract (L2-D27)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof notificationsService>;
  let companyA: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("notif-dedupe-contract");
    db = createDb(testDb.connectionString);
    service = notificationsService(db);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "notifications" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);

    const ts = Date.now();
    const [a] = await db
      .insert(companies)
      .values({
        name: "Acme",
        slug: `acme-${ts}`,
        issuePrefix: `NC${ts}A`,
      })
      .returning({ id: companies.id });
    companyA = a.id;

    const now = new Date();
    const [uA] = await db
      .insert(authUsers)
      .values({
        id: `user-A-${ts}`,
        name: "User A",
        email: `userA-${ts}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: authUsers.id });
    const [uB] = await db
      .insert(authUsers)
      .values({
        id: `user-B-${ts}`,
        name: "User B",
        email: `userB-${ts}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: authUsers.id });
    userA = uA.id;
    userB = uB.id;
  });

  // ───────────────────────────────────────────────────────────────────
  // SCHEMA INVARIANTS — physical constraints must exist on the live DB
  // ───────────────────────────────────────────────────────────────────

  describe("schema invariants", () => {
    it("partial UNIQUE index on (company_id, user_id, kind, ref_kind, ref_id) WHERE read_at IS NULL exists", async () => {
      // pg_indexes.indexdef holds the full CREATE INDEX statement including
      // the WHERE clause — necessary to distinguish a full unique from the
      // partial unique. Both the partial-ness and the column set are
      // load-bearing for the dedupe contract.
      const rows = (await db.execute(sql`
        SELECT indexdef
        FROM pg_indexes
        WHERE tablename = 'notifications'
          AND indexname = 'uniq_notifications_unread_dedup'
      `)) as unknown as Array<{ indexdef: string }>;

      expect(rows.length).toBe(1);
      const def = rows[0].indexdef;
      // Must be a UNIQUE index. A non-unique index would not enforce dedupe.
      expect(def).toMatch(/CREATE UNIQUE INDEX/i);
      // Must carry all five columns. A reduced key would mis-dedupe.
      expect(def).toMatch(/company_id/);
      expect(def).toMatch(/user_id/);
      expect(def).toMatch(/kind/);
      expect(def).toMatch(/ref_kind/);
      expect(def).toMatch(/ref_id/);
      // Must be partial on read_at IS NULL — otherwise re-fire after read
      // (the intentional behavior) silently breaks.
      expect(def).toMatch(/WHERE.*read_at IS NULL/i);
      // Must also gate on ref pair being set — system broadcasts (ref-less)
      // are not deduped.
      expect(def).toMatch(/ref_kind IS NOT NULL/i);
      expect(def).toMatch(/ref_id IS NOT NULL/i);
    });

    it("CHECK constraint '((ref_kind IS NULL) = (ref_id IS NULL))' exists on notifications", async () => {
      // pg_constraint.consrc was removed in PG12; pg_get_constraintdef is
      // the supported way to read CHECK bodies portably.
      const rows = (await db.execute(sql`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass
          AND contype = 'c'
      `)) as unknown as Array<{ def: string }>;

      const defs = rows.map((r) => r.def);
      // PG canonicalizes the CHECK body. Match permissively on both column
      // names appearing under a CHECK with equality between IS NULL exprs.
      const pairCheck = defs.find(
        (d) =>
          /ref_kind/.test(d) &&
          /ref_id/.test(d) &&
          /IS NULL/i.test(d) &&
          // The "=" between the two IS NULL expressions is the contract.
          /=/.test(d),
      );
      expect(pairCheck).toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // RUNTIME DEDUPE — create() is a no-op when an unread match exists,
  // re-fires after read, and pair-CHECK rejects half-set refs
  // ───────────────────────────────────────────────────────────────────

  describe("runtime dedupe semantics", () => {
    it("create() twice with the same target returns the EXISTING unread row", async () => {
      const first = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Approve workflow run",
        refKind: "approval",
        refId: "appr-l2d27-1",
      });

      const second = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Approve workflow run (retry)",
        refKind: "approval",
        refId: "appr-l2d27-1",
      });

      // Same id = the second call was a no-op that returned the original.
      expect(second.id).toBe(first.id);
      // Title preserved from first insert — the second call's title MUST
      // NOT overwrite the existing row, since that would be a write
      // disguised as a dedupe.
      expect(second.title).toBe("Approve workflow run");

      // Only one row physically exists in the table for this dedup key.
      const rows = await service.list(companyA, userA, { unread: true });
      const matchingRefId = rows.filter((r) => r.refId === "appr-l2d27-1");
      expect(matchingRefId).toHaveLength(1);
    });

    it("after markRead, create() with the same target creates a NEW row", async () => {
      // Partial UNIQUE only constrains unread rows. Once the first row is
      // read, a re-fire is the intentional behavior.
      const first = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "First fire",
        refKind: "approval",
        refId: "appr-l2d27-refire",
      });
      const marked = await service.markRead(first.id, companyA, userA);
      expect(marked).toBe(true);

      const second = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Second fire (after ack)",
        refKind: "approval",
        refId: "appr-l2d27-refire",
      });

      // NEW row, distinct id from the read one.
      expect(second.id).not.toBe(first.id);
      // Read row is preserved (not mutated by the second create).
      const [readRow] = (await db.execute(sql`
        SELECT id, read_at, title FROM "notifications" WHERE id = ${first.id}
      `)) as unknown as Array<{ id: string; read_at: Date | null; title: string }>;
      expect(readRow.read_at).not.toBeNull();
      expect(readRow.title).toBe("First fire");
    });

    it("pair-CHECK rejects ref_kind set with ref_id null", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title", "ref_kind", "ref_id")
          VALUES
            (${companyA}::uuid, ${userA}, 'approval_needed', 't', 'approval', NULL)
        `),
      ).rejects.toThrow();
    });

    it("pair-CHECK rejects ref_id set with ref_kind null", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title", "ref_kind", "ref_id")
          VALUES
            (${companyA}::uuid, ${userA}, 'approval_needed', 't', NULL, 'x')
        `),
      ).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // CROSS-USER ENUMERATION GUARD — markRead must return 404 not 403
  // ───────────────────────────────────────────────────────────────────

  describe("cross-user markRead = 404 (NOT 403)", () => {
    it("markRead on another user's real notification id returns 404", async () => {
      // Create a real notification owned by userB.
      const row = await service.create({
        companyId: companyA,
        userId: userB,
        kind: "approval_needed",
        title: "B's secret notif",
        refKind: "approval",
        refId: "appr-l2d27-stolen",
      });

      // Authenticate as userA, who happens to share companyA membership
      // but does NOT own this notification id.
      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).post(
        `/companies/${companyA}/notifications/${row.id}/read`,
      );

      // 404 — not 403, not 401, not 200. This is the structural guard
      // against notification-ID enumeration. A 403 here would leak
      // "this id exists but isn't yours."
      expect(res.status).toBe(404);
      // Body confirms the route-layer disambiguation (the service-level
      // boolean false → route returns 404 with this code).
      expect(res.body.error).toBe("notification_not_found");

      // B's row remains unread — defense check, the failed attempt did
      // not flip read_at as a side effect.
      const [bRow] = (await db.execute(sql`
        SELECT read_at FROM "notifications" WHERE id = ${row.id}
      `)) as unknown as Array<{ read_at: Date | null }>;
      expect(bRow.read_at).toBeNull();
    });

    it("markRead with a non-existent (valid uuid) id also returns 404", async () => {
      // Same status code as cross-user case — the attacker cannot
      // distinguish "id exists but not yours" from "id doesn't exist."
      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const fakeId = "00000000-0000-0000-0000-000000000999";
      const res = await request(app).post(
        `/companies/${companyA}/notifications/${fakeId}/read`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("notification_not_found");
    });
  });
});
