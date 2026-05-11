/**
 * P3 Wave 2 · W2.5 — inbox-state route + schema integration tests.
 *
 * Validates:
 *   1. CHECK rejects invalid `entity_type` values (runtime backstop)
 *   2. CHECK rejects invalid `state` values
 *   3. UNIQUE(user_id, entity_type, entity_id) blocks duplicates
 *   4. POST /snooze — persists, idempotent upsert, future-only
 *   5. POST /archive — sets state=archived + archived_at
 *   6. POST /mark-read — sets state=read + read_at
 *   7. POST /undo-archive — flips back to unread, preserves archived_at
 *   8. GET /me — user-scoped, optional state filter
 *   9. Auth — missing userId → 403; cross-user reads return only own rows
 *  10. Partial index `idx_inbox_state_user_state` physically present
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
import { and, eq, sql } from "drizzle-orm";
import {
  authUsers,
  createDb,
  inboxState,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { inboxStateRoutes } from "../routes/inbox-state.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping inbox-state tests: ${support.reason ?? "unsupported"}`,
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
      userId: "user-default",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use(inboxStateRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("inbox-state (W2.5)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let userA: string;
  let userB: string;
  const approvalIdA = "11111111-1111-1111-1111-111111111111";
  const approvalIdB = "22222222-2222-2222-2222-222222222222";
  const issueIdA = "33333333-3333-3333-3333-333333333333";

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("inbox-state");
    db = createDb(testDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "inbox_state" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);

    const ts = Date.now();
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

  describe("CHECK + UNIQUE constraints (runtime backstop)", () => {
    it("rejects invalid entity_type values", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "inbox_state"
            ("user_id", "entity_type", "entity_id", "state")
          VALUES
            (${userA}, 'made_up_kind', ${approvalIdA}::uuid, 'unread')
        `),
      ).rejects.toThrow();
    });

    it("rejects invalid state values", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "inbox_state"
            ("user_id", "entity_type", "entity_id", "state")
          VALUES
            (${userA}, 'approval', ${approvalIdA}::uuid, 'half_baked')
        `),
      ).rejects.toThrow();
    });

    it("accepts every documented entity_type value", async () => {
      const types = ["approval", "issue", "decision", "mention"] as const;
      for (const [i, type] of types.entries()) {
        const entityId = `4444444${i}-4444-4444-4444-444444444444`;
        await db.insert(inboxState).values({
          userId: userA,
          entityType: type,
          entityId,
          state: "unread",
        });
      }
      const rows = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.userId, userA));
      expect(rows.length).toBe(types.length);
    });

    it("UNIQUE(user, entity_type, entity_id) blocks duplicate inserts", async () => {
      await db.insert(inboxState).values({
        userId: userA,
        entityType: "approval",
        entityId: approvalIdA,
        state: "unread",
      });
      await expect(
        db.insert(inboxState).values({
          userId: userA,
          entityType: "approval",
          entityId: approvalIdA,
          state: "snoozed",
        }),
      ).rejects.toThrow();
    });

    it("UNIQUE allows same entity for different users", async () => {
      await db.insert(inboxState).values({
        userId: userA,
        entityType: "approval",
        entityId: approvalIdA,
        state: "unread",
      });
      await db.insert(inboxState).values({
        userId: userB,
        entityType: "approval",
        entityId: approvalIdA,
        state: "unread",
      });
      const rows = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.entityId, approvalIdA));
      expect(rows.length).toBe(2);
    });
  });

  describe("POST /inbox-state/snooze", () => {
    it("snoozes a row and persists with snoozed_until", async () => {
      const app = buildApp(db, { userId: userA });
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "approval",
          entity_id: approvalIdA,
          snoozed_until: future,
        });
      expect(res.status).toBe(200);
      expect(res.body.row.state).toBe("snoozed");

      const [persisted] = await db
        .select()
        .from(inboxState)
        .where(
          and(
            eq(inboxState.userId, userA),
            eq(inboxState.entityType, "approval"),
            eq(inboxState.entityId, approvalIdA),
          ),
        );
      expect(persisted.state).toBe("snoozed");
      expect(persisted.snoozedUntil).not.toBeNull();
      expect(persisted.snoozedUntil!.getTime()).toBeCloseTo(
        new Date(future).getTime(),
        -2,
      );
    });

    it("is idempotent — second call updates instead of duplicating", async () => {
      const app = buildApp(db, { userId: userA });
      const t1 = new Date(Date.now() + 60_000).toISOString();
      const t2 = new Date(Date.now() + 120_000).toISOString();
      await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "approval",
          entity_id: approvalIdA,
          snoozed_until: t1,
        });
      const res = await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "approval",
          entity_id: approvalIdA,
          snoozed_until: t2,
        });
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.userId, userA));
      expect(rows.length).toBe(1);
      expect(rows[0].snoozedUntil!.getTime()).toBeCloseTo(
        new Date(t2).getTime(),
        -2,
      );
    });

    it("rejects past snoozed_until", async () => {
      const app = buildApp(db, { userId: userA });
      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "approval",
          entity_id: approvalIdA,
          snoozed_until: past,
        });
      expect(res.status).toBe(400);
    });

    it("rejects invalid entity_type via Zod", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "not_a_thing",
          entity_id: approvalIdA,
          snoozed_until: new Date(Date.now() + 60_000).toISOString(),
        });
      expect(res.status).toBe(400);
    });

    it("rejects malformed entity_id (non-uuid)", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "approval",
          entity_id: "not-a-uuid",
          snoozed_until: new Date(Date.now() + 60_000).toISOString(),
        });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /inbox-state/archive", () => {
    it("archives and sets archived_at", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .post("/inbox-state/archive")
        .send({ entity_type: "issue", entity_id: issueIdA });
      expect(res.status).toBe(200);
      expect(res.body.row.state).toBe("archived");
      expect(res.body.row.archivedAt).not.toBeNull();

      const [persisted] = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.entityId, issueIdA));
      expect(persisted.state).toBe("archived");
      expect(persisted.archivedAt).not.toBeNull();
    });

    it("archive hides from unread/snoozed Inbox query", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app)
        .post("/inbox-state/archive")
        .send({ entity_type: "approval", entity_id: approvalIdA });

      const res = await request(app).get("/inbox-state/me?state=unread,snoozed");
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(0);
    });
  });

  describe("POST /inbox-state/mark-read", () => {
    it("sets state=read and read_at", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "mention", entity_id: approvalIdA });
      expect(res.status).toBe(200);
      expect(res.body.row.state).toBe("read");
      expect(res.body.row.readAt).not.toBeNull();
    });

    it("is idempotent — second mark-read updates updated_at but stays read", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      const res = await request(app)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.userId, userA));
      expect(rows.length).toBe(1);
      expect(rows[0].state).toBe("read");
    });
  });

  describe("POST /inbox-state/undo-archive", () => {
    it("flips archived → unread, preserves archived_at trail", async () => {
      const app = buildApp(db, { userId: userA });
      // 1. Archive.
      await request(app)
        .post("/inbox-state/archive")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      const [afterArchive] = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.userId, userA));
      const archivedAtFirst = afterArchive.archivedAt;
      expect(archivedAtFirst).not.toBeNull();

      // 2. Undo.
      const res = await request(app)
        .post("/inbox-state/undo-archive")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      expect(res.status).toBe(200);
      expect(res.body.row.state).toBe("unread");

      // 3. archived_at preserved as forensic trail.
      const [afterUndo] = await db
        .select()
        .from(inboxState)
        .where(eq(inboxState.userId, userA));
      expect(afterUndo.state).toBe("unread");
      expect(afterUndo.archivedAt).not.toBeNull();
      expect(afterUndo.archivedAt!.getTime()).toBe(archivedAtFirst!.getTime());
    });

    it("undo on a never-archived row creates an unread row (no 404)", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .post("/inbox-state/undo-archive")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      expect(res.status).toBe(200);
      expect(res.body.row.state).toBe("unread");
    });
  });

  describe("GET /inbox-state/me", () => {
    it("returns only the caller's rows (cross-user isolation)", async () => {
      // userA: 1 row. userB: 1 row.
      const appA = buildApp(db, { userId: userA });
      await request(appA)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "approval", entity_id: approvalIdA });

      const appB = buildApp(db, { userId: userB });
      await request(appB)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "approval", entity_id: approvalIdB });

      const resA = await request(appA).get("/inbox-state/me");
      expect(resA.status).toBe(200);
      expect(resA.body.rows).toHaveLength(1);
      expect(resA.body.rows[0].entityId).toBe(approvalIdA);

      const resB = await request(appB).get("/inbox-state/me");
      expect(resB.body.rows).toHaveLength(1);
      expect(resB.body.rows[0].entityId).toBe(approvalIdB);
    });

    it("?state=unread,snoozed filters to the in-tray subset", async () => {
      const app = buildApp(db, { userId: userA });
      // Seed: one read, one archived, one snoozed.
      await request(app).post("/inbox-state/mark-read").send({
        entity_type: "approval",
        entity_id: approvalIdA,
      });
      await request(app).post("/inbox-state/archive").send({
        entity_type: "issue",
        entity_id: issueIdA,
      });
      await request(app)
        .post("/inbox-state/snooze")
        .send({
          entity_type: "decision",
          entity_id: approvalIdB,
          snoozed_until: new Date(Date.now() + 60_000).toISOString(),
        });

      const res = await request(app).get("/inbox-state/me?state=unread,snoozed");
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].state).toBe("snoozed");
    });

    it("no filter returns every state for the user", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app).post("/inbox-state/mark-read").send({
        entity_type: "approval",
        entity_id: approvalIdA,
      });
      await request(app).post("/inbox-state/archive").send({
        entity_type: "issue",
        entity_id: issueIdA,
      });

      const res = await request(app).get("/inbox-state/me");
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(2);
    });

    it("rejects an invalid state filter value", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app).get("/inbox-state/me?state=banana");
      expect(res.status).toBe(400);
    });
  });

  describe("auth", () => {
    it("missing userId → 403", async () => {
      const app = buildApp(db, { userId: null });
      const res = await request(app)
        .post("/inbox-state/mark-read")
        .send({ entity_type: "approval", entity_id: approvalIdA });
      expect(res.status).toBe(403);
    });

    it("non-board actor → 403", async () => {
      const app = buildApp(db, { type: "agent", userId: null, agentId: "x" });
      const res = await request(app).get("/inbox-state/me");
      expect(res.status).toBe(403);
    });
  });

  describe("indexes", () => {
    it("idx_inbox_state_user_state exists", async () => {
      const result = (await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'inbox_state'
          AND indexname = 'idx_inbox_state_user_state'
      `)) as unknown as Array<{ indexname: string }>;
      expect(result.length).toBe(1);
    });

    it("UNIQUE inbox_state_user_entity_unique exists", async () => {
      const result = (await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'inbox_state'
          AND indexname = 'inbox_state_user_entity_unique'
      `)) as unknown as Array<{ indexname: string }>;
      expect(result.length).toBe(1);
    });
  });
});
