/**
 * Sprint 6 · S6.8 — onboarding draft persistence integration tests.
 *
 * Validates the save-and-resume backbone end-to-end against real Postgres:
 *   1. CHECK constraint rejects current_step outside [1, 8]
 *   2. partial UNIQUE permits multiple completed drafts but exactly one in-progress
 *   3. service.getOrCreate is idempotent (returns existing or creates fresh)
 *   4. service.save persists currentStep + draft jsonb opaquely
 *   5. service.save returns null when no in-progress draft exists
 *   6. service.save rejects out-of-bounds currentStep
 *   7. service.complete flips completedAt; subsequent getOrCreate creates a new draft
 *   8. service.complete returns null when no in-progress draft
 *   9. service.listForUser returns history newest-first
 *  10. routes — GET creates, PUT saves, POST complete works
 *  11. routes — cross-user isolation (each user sees only their own)
 *  12. routes — missing user identity → 403
 *  13. routes — PUT without GET first → 409 no_active_draft
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  authUsers,
  createDb,
  onboardingDrafts,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { onboardingDraftService } from "../services/onboarding-drafts.js";
import { onboardingDraftRoutes } from "../routes/onboarding-draft.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping onboarding-draft tests: ${support.reason ?? "unsupported"}`);
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
  app.use(onboardingDraftRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("onboarding draft (S6.8)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof onboardingDraftService>;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("onboarding-draft");
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
    const [b] = await db
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
    userA = a.id;
    userB = b.id;
  });

  describe("CHECK constraints", () => {
    it("rejects current_step < 1", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "onboarding_drafts" ("user_id", "current_step")
          VALUES (${userA}, 0)
        `),
      ).rejects.toThrow();
    });

    it("rejects current_step > 8", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "onboarding_drafts" ("user_id", "current_step")
          VALUES (${userA}, 9)
        `),
      ).rejects.toThrow();
    });

    it("accepts current_step = 1 (lower bound)", async () => {
      const draft = await service.getOrCreate(userA);
      expect(draft.currentStep).toBe(1);
    });

    it("accepts current_step = 8 (upper bound)", async () => {
      const initial = await service.getOrCreate(userA);
      const saved = await service.save(userA, { currentStep: 8, draft: {} });
      expect(saved!.currentStep).toBe(8);
      expect(saved!.id).toBe(initial.id);
    });
  });

  describe("partial UNIQUE — at most one in-progress draft per user", () => {
    it("rejects a second in-progress draft for the same user", async () => {
      await service.getOrCreate(userA);
      // Direct INSERT — bypasses the service's getOrCreate idempotency.
      await expect(
        db.execute(sql`
          INSERT INTO "onboarding_drafts" ("user_id", "current_step")
          VALUES (${userA}, 1)
        `),
      ).rejects.toThrow();
    });

    it("permits multiple completed drafts + one in-progress for the same user", async () => {
      await service.getOrCreate(userA);
      await service.complete(userA);
      // Re-onboarding: a fresh in-progress draft is allowed once previous is completed.
      const second = await service.getOrCreate(userA);
      expect(second.completedAt).toBeNull();
      await service.complete(userA);
      const third = await service.getOrCreate(userA);
      expect(third.completedAt).toBeNull();

      const all = await service.listForUser(userA);
      expect(all).toHaveLength(3);
      const completedCount = all.filter((d) => d.completedAt !== null).length;
      expect(completedCount).toBe(2);
    });
  });

  describe("service.getOrCreate", () => {
    it("creates a fresh draft when none exists", async () => {
      const draft = await service.getOrCreate(userA);
      expect(draft.userId).toBe(userA);
      expect(draft.currentStep).toBe(1);
      expect(draft.draft).toEqual({});
      expect(draft.completedAt).toBeNull();
    });

    it("returns the same draft on repeat calls (idempotent)", async () => {
      const first = await service.getOrCreate(userA);
      const second = await service.getOrCreate(userA);
      expect(second.id).toBe(first.id);
    });

    it("returns a fresh draft after the previous one was completed", async () => {
      const first = await service.getOrCreate(userA);
      await service.complete(userA);
      const second = await service.getOrCreate(userA);
      expect(second.id).not.toBe(first.id);
    });
  });

  describe("service.save", () => {
    it("persists currentStep + draft as opaque jsonb", async () => {
      await service.getOrCreate(userA);
      const draftPayload = {
        vision: "AI control plane for founders",
        team: { eng: 2, design: 1 },
        nested: { deep: { value: 42 } },
      };
      const saved = await service.save(userA, { currentStep: 4, draft: draftPayload });
      expect(saved!.currentStep).toBe(4);
      expect(saved!.draft).toEqual(draftPayload);
    });

    it("returns null when no in-progress draft exists", async () => {
      const saved = await service.save(userA, { currentStep: 2, draft: {} });
      expect(saved).toBeNull();
    });

    it("returns null after completion (in-progress no longer exists)", async () => {
      await service.getOrCreate(userA);
      await service.complete(userA);
      const saved = await service.save(userA, { currentStep: 2, draft: {} });
      expect(saved).toBeNull();
    });

    it("rejects out-of-bounds currentStep at the service layer", async () => {
      await service.getOrCreate(userA);
      await expect(
        service.save(userA, { currentStep: 99, draft: {} }),
      ).rejects.toThrow(/currentStep/);
      await expect(
        service.save(userA, { currentStep: 0, draft: {} }),
      ).rejects.toThrow(/currentStep/);
    });
  });

  describe("service.complete", () => {
    it("flips completedAt", async () => {
      await service.getOrCreate(userA);
      const completed = await service.complete(userA);
      expect(completed!.completedAt).not.toBeNull();
    });

    it("returns null when no in-progress draft", async () => {
      const result = await service.complete(userA);
      expect(result).toBeNull();
    });

    it("is idempotent — second call returns null (no double-complete)", async () => {
      await service.getOrCreate(userA);
      const first = await service.complete(userA);
      expect(first).not.toBeNull();
      const second = await service.complete(userA);
      expect(second).toBeNull();
    });
  });

  describe("cross-user isolation", () => {
    it("user A's draft is invisible to user B", async () => {
      await service.getOrCreate(userA);
      await service.save(userA, { currentStep: 3, draft: { secret: "A only" } });

      const bDraft = await service.getOrCreate(userB);
      expect(bDraft.userId).toBe(userB);
      expect(bDraft.draft).toEqual({});
    });

    it("save by user B does not affect user A's draft", async () => {
      const a = await service.getOrCreate(userA);
      await service.save(userA, { currentStep: 3, draft: { for: "A" } });

      await service.getOrCreate(userB);
      await service.save(userB, { currentStep: 5, draft: { for: "B" } });

      const aAgain = await service.getOrCreate(userA);
      expect(aAgain.id).toBe(a.id);
      expect(aAgain.currentStep).toBe(3);
      expect(aAgain.draft).toEqual({ for: "A" });
    });
  });

  describe("routes", () => {
    it("GET creates a fresh draft on first call", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app).get("/onboarding/draft");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(userA);
      expect(res.body.currentStep).toBe(1);
    });

    it("GET is idempotent — second call returns same id", async () => {
      const app = buildApp(db, { userId: userA });
      const r1 = await request(app).get("/onboarding/draft");
      const r2 = await request(app).get("/onboarding/draft");
      expect(r2.body.id).toBe(r1.body.id);
    });

    it("PUT after GET saves currentStep + draft", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app).get("/onboarding/draft");

      const res = await request(app)
        .put("/onboarding/draft")
        .send({ currentStep: 5, draft: { name: "Acme" } });
      expect(res.status).toBe(200);
      expect(res.body.currentStep).toBe(5);
      expect(res.body.draft).toEqual({ name: "Acme" });
    });

    it("PUT without prior GET → 409 no_active_draft", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app)
        .put("/onboarding/draft")
        .send({ currentStep: 2, draft: {} });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("no_active_draft");
    });

    it("POST .../complete marks the draft completed", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app).get("/onboarding/draft");
      const res = await request(app).post("/onboarding/draft/complete");
      expect(res.status).toBe(200);
      expect(res.body.completedAt).not.toBeNull();
    });

    it("POST .../complete with no active draft → 409", async () => {
      const app = buildApp(db, { userId: userA });
      const res = await request(app).post("/onboarding/draft/complete");
      expect(res.status).toBe(409);
    });

    it("PUT validates currentStep bounds → 400", async () => {
      const app = buildApp(db, { userId: userA });
      await request(app).get("/onboarding/draft");
      const res = await request(app)
        .put("/onboarding/draft")
        .send({ currentStep: 99, draft: {} });
      expect(res.status).toBe(400);
    });

    it("missing user identity → 403", async () => {
      const app = buildApp(db, { userId: null });
      const res = await request(app).get("/onboarding/draft");
      expect(res.status).toBe(403);
    });

    it("user B cannot read or write user A's draft (per-user scoping)", async () => {
      // User A populates a draft.
      const appA = buildApp(db, { userId: userA });
      await request(appA).get("/onboarding/draft");
      await request(appA)
        .put("/onboarding/draft")
        .send({ currentStep: 3, draft: { secret: "A's data" } });

      // User B reads — gets a fresh draft, NOT A's.
      const appB = buildApp(db, { userId: userB });
      const res = await request(appB).get("/onboarding/draft");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(userB);
      expect(res.body.draft).toEqual({});
      expect(res.body.currentStep).toBe(1);
    });
  });
});
