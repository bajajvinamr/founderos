/**
 * Sprint 6 · S6.6 — notifications integration tests.
 *
 * Validates the data layer end-to-end:
 *   1. CHECK rejects invalid `kind` values
 *   2. CHECK rejects invalid `ref_kind` values
 *   3. CHECK enforces "ref_kind and ref_id both null or both set"
 *   4. service.create dedupes on (user, kind, refKind, refId, unread)
 *   5. service.list filters by unread + tenant + user
 *   6. service.unreadCount uses the partial index path
 *   7. service.markRead is tenant + user scoped (stolen ids fail)
 *   8. service.markRead is idempotent (already-read returns true)
 *   9. service.markAllRead returns the affected count
 *  10. partial indexes physically present
 *  11. routes — list / unread-count / mark-read / mark-all happy paths
 *  12. routes — cross-tenant 403, missing-user 403
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
  console.warn(`Skipping notifications tests: ${support.reason ?? "unsupported"}`);
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

describeEmbeddedPostgres("notifications (S6.6)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof notificationsService>;
  let companyA: string;
  let companyB: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("notifications");
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
      .values({ name: "Acme", slug: `acme-${ts}`, issuePrefix: `NA${ts}A` })
      .returning({ id: companies.id });
    const [b] = await db
      .insert(companies)
      .values({ name: "Beta", slug: `beta-${ts}`, issuePrefix: `NA${ts}B` })
      .returning({ id: companies.id });
    companyA = a.id;
    companyB = b.id;

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

  describe("CHECK constraints", () => {
    it("rejects invalid kind values", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title")
          VALUES
            (${companyA}::uuid, ${userA}, 'made_up_kind', 'x')
        `),
      ).rejects.toThrow();
    });

    it("rejects invalid ref_kind values", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title", "ref_kind", "ref_id")
          VALUES
            (${companyA}::uuid, ${userA}, 'approval_needed', 'x', 'fake', 'abc')
        `),
      ).rejects.toThrow();
    });

    it("rejects ref_kind set without ref_id", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title", "ref_kind", "ref_id")
          VALUES
            (${companyA}::uuid, ${userA}, 'approval_needed', 'x', 'approval', NULL)
        `),
      ).rejects.toThrow();
    });

    it("rejects ref_id set without ref_kind", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "notifications"
            ("company_id", "user_id", "kind", "title", "ref_kind", "ref_id")
          VALUES
            (${companyA}::uuid, ${userA}, 'approval_needed', 'x', NULL, 'abc')
        `),
      ).rejects.toThrow();
    });

    it("accepts both ref columns null (no ref)", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "insight_critical",
        title: "Untargeted insight",
      });
      expect(row.refKind).toBeNull();
      expect(row.refId).toBeNull();
    });

    it("accepts both ref columns set together", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Approve workflow run",
        refKind: "approval",
        refId: "appr-123",
      });
      expect(row.refKind).toBe("approval");
      expect(row.refId).toBe("appr-123");
    });
  });

  describe("service.create — dedup on unread", () => {
    it("returns existing row when same (user, kind, ref) is already unread", async () => {
      const first = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Approve workflow run",
        refKind: "approval",
        refId: "appr-dedup",
      });

      const second = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Approve workflow run (retry)",
        refKind: "approval",
        refId: "appr-dedup",
      });

      expect(second.id).toBe(first.id);
      // Title should NOT be updated — dedup returns the original row as-is.
      expect(second.title).toBe("Approve workflow run");
    });

    it("does NOT dedup once the existing row is marked read", async () => {
      const first = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "First",
        refKind: "approval",
        refId: "appr-redo",
      });
      await service.markRead(first.id, companyA, userA);

      const second = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "Second",
        refKind: "approval",
        refId: "appr-redo",
      });

      expect(second.id).not.toBe(first.id);
    });

    it("does NOT dedup across users (same ref but different recipient)", async () => {
      const first = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "For A",
        refKind: "approval",
        refId: "appr-shared",
      });
      const second = await service.create({
        companyId: companyA,
        userId: userB,
        kind: "approval_needed",
        title: "For B",
        refKind: "approval",
        refId: "appr-shared",
      });

      expect(second.id).not.toBe(first.id);
    });
  });

  describe("service.list / unreadCount", () => {
    beforeEach(async () => {
      // Seed: 2 unread for userA in companyA, 1 read for userA in companyA,
      // 1 unread for userB in companyA, 1 unread for userA in companyB.
      await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "A1",
      });
      await service.create({
        companyId: companyA,
        userId: userA,
        kind: "insight_critical",
        title: "A2",
      });
      const a3 = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "workflow_completed",
        title: "A3 read",
      });
      await service.markRead(a3.id, companyA, userA);
      await service.create({
        companyId: companyA,
        userId: userB,
        kind: "approval_needed",
        title: "B-on-A",
      });
      await service.create({
        companyId: companyB,
        userId: userA,
        kind: "approval_needed",
        title: "A-on-B",
      });
    });

    it("list returns only this user's notifications in this company", async () => {
      const rows = await service.list(companyA, userA);
      expect(rows.map((r) => r.title).sort()).toEqual(["A1", "A2", "A3 read"]);
    });

    it("list with unread=true filters to unread", async () => {
      const rows = await service.list(companyA, userA, { unread: true });
      expect(rows.map((r) => r.title).sort()).toEqual(["A1", "A2"]);
    });

    it("list with unread=false filters to read", async () => {
      const rows = await service.list(companyA, userA, { unread: false });
      expect(rows.map((r) => r.title)).toEqual(["A3 read"]);
    });

    it("unreadCount is tenant + user scoped", async () => {
      expect(await service.unreadCount(companyA, userA)).toBe(2);
      expect(await service.unreadCount(companyA, userB)).toBe(1);
      expect(await service.unreadCount(companyB, userA)).toBe(1);
    });
  });

  describe("service.markRead", () => {
    it("returns false for a non-existent id", async () => {
      // notifications.id is uuid, so use a uuid literal that won't exist.
      const ok = await service.markRead(
        "00000000-0000-0000-0000-000000000999",
        companyA,
        userA,
      );
      expect(ok).toBe(false);
    });

    it("returns false for a wrong-user id (cross-user theft blocked)", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "A's notif",
      });
      const ok = await service.markRead(row.id, companyA, userB);
      expect(ok).toBe(false);

      // Confirm A's row is still unread.
      const [stillThere] = await service.list(companyA, userA, { unread: true });
      expect(stillThere.id).toBe(row.id);
    });

    it("returns false for a wrong-tenant id", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "A's notif",
      });
      const ok = await service.markRead(row.id, companyB, userA);
      expect(ok).toBe(false);
    });

    it("is idempotent — marking an already-read row returns true", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "A's notif",
      });
      expect(await service.markRead(row.id, companyA, userA)).toBe(true);
      expect(await service.markRead(row.id, companyA, userA)).toBe(true);
    });
  });

  describe("service.markAllRead", () => {
    it("marks all unread in (company, user) and returns count", async () => {
      await service.create({ companyId: companyA, userId: userA, kind: "approval_needed", title: "1" });
      await service.create({ companyId: companyA, userId: userA, kind: "insight_critical", title: "2" });
      await service.create({ companyId: companyA, userId: userA, kind: "workflow_completed", title: "3" });
      // Other user — must NOT be touched.
      await service.create({ companyId: companyA, userId: userB, kind: "approval_needed", title: "B" });

      const updated = await service.markAllRead(companyA, userA);
      expect(updated).toBe(3);

      expect(await service.unreadCount(companyA, userA)).toBe(0);
      expect(await service.unreadCount(companyA, userB)).toBe(1);
    });
  });

  describe("indexes", () => {
    it("idx_notifications_user_unread exists", async () => {
      const result = (await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'notifications'
          AND indexname = 'idx_notifications_user_unread'
      `)) as unknown as Array<{ indexname: string }>;
      expect(result.length).toBe(1);
    });

    it("idx_notifications_user_created exists", async () => {
      const result = (await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'notifications'
          AND indexname = 'idx_notifications_user_created'
      `)) as unknown as Array<{ indexname: string }>;
      expect(result.length).toBe(1);
    });
  });

  describe("routes", () => {
    it("GET .../notifications lists this user's rows", async () => {
      await service.create({ companyId: companyA, userId: userA, kind: "approval_needed", title: "A1" });
      await service.create({ companyId: companyA, userId: userA, kind: "insight_critical", title: "A2" });

      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).get(`/companies/${companyA}/notifications`);
      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(2);
    });

    it("GET .../unread-count returns the badge value", async () => {
      await service.create({ companyId: companyA, userId: userA, kind: "approval_needed", title: "1" });

      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).get(
        `/companies/${companyA}/notifications/unread-count`,
      );
      expect(res.status).toBe(200);
      expect(res.body.unreadCount).toBe(1);
    });

    it("POST .../:id/read marks read; second call still 200 (idempotent)", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userA,
        kind: "approval_needed",
        title: "to-read",
      });

      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const r1 = await request(app).post(
        `/companies/${companyA}/notifications/${row.id}/read`,
      );
      expect(r1.status).toBe(200);
      const r2 = await request(app).post(
        `/companies/${companyA}/notifications/${row.id}/read`,
      );
      expect(r2.status).toBe(200);

      expect(await service.unreadCount(companyA, userA)).toBe(0);
    });

    it("POST .../read-all returns updatedCount", async () => {
      await service.create({ companyId: companyA, userId: userA, kind: "approval_needed", title: "1" });
      await service.create({ companyId: companyA, userId: userA, kind: "insight_critical", title: "2" });

      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).post(
        `/companies/${companyA}/notifications/read-all`,
      );
      expect(res.status).toBe(200);
      expect(res.body.updatedCount).toBe(2);
    });

    it("cross-tenant access → 403", async () => {
      await service.create({ companyId: companyB, userId: userA, kind: "approval_needed", title: "secret" });

      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).get(`/companies/${companyB}/notifications`);
      expect(res.status).toBe(403);
    });

    it("missing user identity → 403", async () => {
      const app = buildApp(db, { userId: null, companyIds: [companyA] });
      const res = await request(app).get(`/companies/${companyA}/notifications`);
      expect(res.status).toBe(403);
    });

    it("POST /:id/read with stolen id from another user → 404", async () => {
      const row = await service.create({
        companyId: companyA,
        userId: userB,
        kind: "approval_needed",
        title: "B's notif",
      });

      // userA tries to mark userB's notif as read in the same company
      const app = buildApp(db, { userId: userA, companyIds: [companyA] });
      const res = await request(app).post(
        `/companies/${companyA}/notifications/${row.id}/read`,
      );
      expect(res.status).toBe(404);
    });
  });
});
