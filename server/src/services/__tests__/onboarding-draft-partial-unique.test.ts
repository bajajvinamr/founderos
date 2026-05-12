/**
 * Sprint 6 · S6.8 — onboarding draft partial UNIQUE + race-safe getOrCreate
 * structural regression test (Loop 2 · L2-D28).
 *
 * Locks in the documented vinamr-invariant (CLAUDE.md, 2026-05-06):
 *
 *   "Onboarding drafts use a partial UNIQUE on (user_id) WHERE
 *    completed_at IS NULL. This permits one in-progress draft per user
 *    but allows re-onboarding after completion (the completed row's
 *    completed_at is non-NULL, so it's outside the partial index).
 *    getOrCreate() handles the race via try-insert → catch-on-conflict
 *    → re-read; do NOT replace it with a SELECT-or-INSERT pattern
 *    (TOCTOU window). PUT-without-prior-GET returns 409 no_active_draft
 *    deliberately — the wizard MUST call GET on mount to create or
 *    surface the draft before any save."
 *
 * Regression risks defended:
 *   1. Dropping the partial UNIQUE → users accumulate multiple
 *      in-progress drafts; wizard becomes ambiguous about which draft
 *      to resume.
 *   2. Replacing `try-insert → catch-on-conflict` with `SELECT → INSERT
 *      if missing` → TOCTOU window where two concurrent first-mount
 *      requests both create a draft.
 *   3. Auto-creating an in-progress draft on PUT → masks UX bugs where
 *      the wizard never called GET (state desync between server + UI).
 *
 * Companion to `server/src/__tests__/onboarding-draft.test.ts` (the
 * existing behavioral suite). This file is intentionally structural:
 * the assertions verify the *contract*, not the wizard flow.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { authUsers, createDb, onboardingDrafts } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { onboardingDraftService } from "../onboarding-drafts.js";
import { onboardingDraftRoutes } from "../../routes/onboarding-draft.js";
import { errorHandler } from "../../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping onboarding-draft-partial-unique tests: ${support.reason ?? "unsupported"}`,
  );
}

function buildApp(
  db: ReturnType<typeof createDb>,
  actorOverrides: Record<string, unknown> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).actor = {
      type: "board",
      userId: "user-default",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use(onboardingDraftRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres(
  "onboarding draft partial UNIQUE + race-safe getOrCreate (S6.8 / L2-D28)",
  () => {
    let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    let service: ReturnType<typeof onboardingDraftService>;
    let userA: string;

    beforeAll(async () => {
      testDb = await startEmbeddedPostgresTestDatabase(
        "onboarding-draft-partial-unique",
      );
      db = createDb(testDb.connectionString);
      service = onboardingDraftService(db);
    }, 60_000);

    afterAll(async () => {
      await testDb.cleanup();
    });

    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE "onboarding_drafts" CASCADE`);
      await db.execute(sql`TRUNCATE TABLE "user" CASCADE`);

      const ts = Date.now();
      const now = new Date();
      const [a] = await db
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
      userA = a.id;
    });

    describe("schema contract", () => {
      it("partial UNIQUE index idx_onboarding_drafts_user_active exists", async () => {
        const result = (await db.execute(sql`
          SELECT indexname FROM pg_indexes
          WHERE tablename = 'onboarding_drafts'
            AND indexname = 'idx_onboarding_drafts_user_active'
        `)) as unknown as Array<{ indexname: string }>;
        expect(result.length).toBe(1);
      });

      it("index is UNIQUE and partial on `WHERE completed_at IS NULL`", async () => {
        // Without the partial predicate, finished+in-progress drafts for the
        // same user would all collide (re-onboarding bricked). Without
        // UNIQUE, two in-progress drafts can coexist (wizard ambiguity).
        const result = (await db.execute(sql`
          SELECT indexdef FROM pg_indexes
          WHERE tablename = 'onboarding_drafts'
            AND indexname = 'idx_onboarding_drafts_user_active'
        `)) as unknown as Array<{ indexdef: string }>;
        expect(result.length).toBe(1);
        const def = result[0].indexdef.toUpperCase();
        // UNIQUE clause must be present.
        expect(def).toMatch(/CREATE UNIQUE INDEX/);
        // Partial predicate must filter to in-progress rows only.
        expect(def).toMatch(/WHERE\s*\(?\s*COMPLETED_AT IS NULL/);
        // Keyed on user_id.
        expect(def).toMatch(/\(USER_ID\)/);
      });
    });

    describe("getOrCreate idempotency", () => {
      it("two sequential calls return the same draft id", async () => {
        const first = await service.getOrCreate(userA);
        const second = await service.getOrCreate(userA);
        expect(second.id).toBe(first.id);

        // And only one row exists.
        const rows = await db
          .select()
          .from(onboardingDrafts)
          .where(sql`${onboardingDrafts.userId} = ${userA}`);
        expect(rows).toHaveLength(1);
      });

      it("re-onboarding: getOrCreate AFTER complete creates a NEW draft", async () => {
        // First wizard run.
        const first = await service.getOrCreate(userA);
        const completed = await service.complete(userA);
        expect(completed!.completedAt).not.toBeNull();

        // Second wizard run — partial UNIQUE allows a fresh in-progress
        // draft because the completed row's completed_at is non-NULL
        // (outside the partial index).
        const second = await service.getOrCreate(userA);
        expect(second.id).not.toBe(first.id);
        expect(second.completedAt).toBeNull();

        // Total: one completed + one in-progress = 2 rows.
        const rows = await db
          .select()
          .from(onboardingDrafts)
          .where(sql`${onboardingDrafts.userId} = ${userA}`);
        expect(rows).toHaveLength(2);
        const completedCount = rows.filter((r) => r.completedAt !== null).length;
        const inProgressCount = rows.filter((r) => r.completedAt === null).length;
        expect(completedCount).toBe(1);
        expect(inProgressCount).toBe(1);
      });
    });

    describe("concurrency — partial UNIQUE + try-insert/catch-on-conflict", () => {
      it("two simultaneous getOrCreate calls produce exactly ONE row", async () => {
        // This is the race that motivates the partial UNIQUE in the first
        // place. The naive SELECT-or-INSERT pattern has a TOCTOU window
        // where both callers observe "no row" and both INSERT. The
        // partial UNIQUE rejects the loser; the service catches the
        // conflict and re-reads the winner's row.
        const [first, second] = await Promise.all([
          service.getOrCreate(userA),
          service.getOrCreate(userA),
        ]);

        // Both calls must succeed (neither throws).
        expect(first).toBeDefined();
        expect(second).toBeDefined();

        // And they must observe the SAME row id.
        expect(second.id).toBe(first.id);

        // The DB must hold exactly ONE in-progress draft for this user.
        const rows = await db
          .select()
          .from(onboardingDrafts)
          .where(sql`${onboardingDrafts.userId} = ${userA}`);
        expect(rows).toHaveLength(1);
        expect(rows[0].completedAt).toBeNull();
      });

      it("higher concurrency (5 parallel) — exactly ONE row still", async () => {
        // Defense in depth: amp the race up. The partial UNIQUE + retry
        // pattern must remain race-safe under N>2 contenders too.
        const results = await Promise.all(
          Array.from({ length: 5 }, () => service.getOrCreate(userA)),
        );
        expect(results).toHaveLength(5);
        const ids = new Set(results.map((r) => r.id));
        expect(ids.size).toBe(1);

        const rows = await db
          .select()
          .from(onboardingDrafts)
          .where(sql`${onboardingDrafts.userId} = ${userA}`);
        expect(rows).toHaveLength(1);
      });
    });

    describe("PUT without prior GET — 409 no_active_draft", () => {
      it("PUT before any GET returns 409 with body code `no_active_draft`", async () => {
        // The wizard MUST call GET on mount to materialize an
        // in-progress draft. PUT without an active draft is a UX bug
        // signal — the server refuses to silently auto-create on PUT.
        const app = buildApp(db, { userId: userA });
        const res = await request(app)
          .put("/onboarding/draft")
          .send({ currentStep: 3, draft: { name: "Acme" } });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("no_active_draft");
      });

      it("PUT after complete (no in-progress) returns 409 no_active_draft", async () => {
        // Same path at the service layer: even after a completed
        // wizard, the next PUT must 409 until GET re-materializes a
        // fresh in-progress draft.
        await service.getOrCreate(userA);
        await service.complete(userA);

        const app = buildApp(db, { userId: userA });
        const res = await request(app)
          .put("/onboarding/draft")
          .send({ currentStep: 2, draft: {} });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("no_active_draft");
      });

      it("service.save returns null when no in-progress draft exists", async () => {
        // The 409 in the route layer is sourced from service.save
        // returning null. Lock the service contract directly so a
        // refactor of the route can't quietly drop the 409.
        const saved = await service.save(userA, { currentStep: 2, draft: {} });
        expect(saved).toBeNull();
      });
    });
  },
);
