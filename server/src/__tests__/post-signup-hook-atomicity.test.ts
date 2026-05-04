import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import {
  authUsers,
  createDb,
  instanceUserRoles,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { LOCAL_BOARD_USER_ID, runPostSignupBootstrap } from "../auth/post-signup-hook.ts";

// Council 2026-05-03 P1 — first-user-wins race regression.
//
// The previous implementation read `instance_admin` count, decided to
// promote based on the read, then inserted — a classic TOCTOU race.
// Two concurrent signups could BOTH observe zero admins and BOTH end
// up promoted, breaking the "first user wins" invariant. The unique
// index on (user_id, role) does not catch this because user_ids differ.
//
// This test runs N concurrent runPostSignupBootstrap calls against
// embedded Postgres (real concurrent transactions, not pglite's
// in-process serialization) and asserts that exactly ONE row with
// role=instance_admin (excluding LOCAL_BOARD_USER_ID) is created,
// regardless of concurrency. The atomic fix uses a transaction +
// pg_advisory_xact_lock + read-inside-lock to enforce this.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping post-signup-hook atomicity tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("runPostSignupBootstrap — first-admin-wins atomicity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-post-signup-atomic-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Strip every admin row between cases — including the synthetic local
    // principal — so each test starts from a clean "no admin yet" state.
    // Role rows go first so the FK on instance_user_roles.user_id doesn't
    // block the authUsers wipe.
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function countHumanAdmins(): Promise<number> {
    const rows = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(
        and(
          eq(instanceUserRoles.role, "instance_admin"),
          ne(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
        ),
      );
    return rows.length;
  }

  it("single signup: promotes the user to instance_admin (sanity)", async () => {
    const result = await runPostSignupBootstrap(db, {
      userId: "user-1",
      email: "user-1@example.com",
    });
    expect(result.promotedToInstanceAdmin).toBe(true);
    expect(await countHumanAdmins()).toBe(1);
  });

  it("two concurrent signups: exactly ONE wins, never both", async () => {
    const [r1, r2] = await Promise.all([
      runPostSignupBootstrap(db, { userId: "user-A", email: "a@example.com" }),
      runPostSignupBootstrap(db, { userId: "user-B", email: "b@example.com" }),
    ]);
    const promotionCount = [r1, r2].filter((r) => r.promotedToInstanceAdmin).length;
    expect(promotionCount).toBe(1);
    expect(await countHumanAdmins()).toBe(1);
  });

  it("ten concurrent signups: still exactly ONE wins", async () => {
    const userIds = Array.from({ length: 10 }, (_, i) => `user-${i}`);
    const results = await Promise.all(
      userIds.map((uid) =>
        runPostSignupBootstrap(db, { userId: uid, email: `${uid}@example.com` }),
      ),
    );
    const promotionCount = results.filter((r) => r.promotedToInstanceAdmin).length;
    expect(promotionCount).toBe(1);
    expect(await countHumanAdmins()).toBe(1);
  });

  it("subsequent signups after bootstrap window do NOT auto-promote", async () => {
    await runPostSignupBootstrap(db, { userId: "founder", email: "f@example.com" });
    expect(await countHumanAdmins()).toBe(1);

    // Three more signups arrive after a human admin already exists. None
    // should be promoted.
    const post = await Promise.all([
      runPostSignupBootstrap(db, { userId: "later-1", email: "l1@example.com" }),
      runPostSignupBootstrap(db, { userId: "later-2", email: "l2@example.com" }),
      runPostSignupBootstrap(db, { userId: "later-3", email: "l3@example.com" }),
    ]);
    expect(post.every((r) => !r.promotedToInstanceAdmin)).toBe(true);
    expect(await countHumanAdmins()).toBe(1);
  });

  it("LOCAL_BOARD_USER_ID is not counted as a human admin", async () => {
    // Seed the synthetic principal — represents local_trusted board access.
    // ensureLocalTrustedBoardPrincipal in server/src/index.ts seeds both
    // the authUsers and instanceUserRoles rows; replicate that here so the
    // FK on instance_user_roles.user_id is satisfied.
    const now = new Date();
    await db.insert(authUsers).values({
      id: LOCAL_BOARD_USER_ID,
      name: "Board",
      email: "local@founderos.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_BOARD_USER_ID,
      role: "instance_admin",
    });
    expect(await countHumanAdmins()).toBe(0);

    // First human signup should still be promoted despite the local-board row.
    const result = await runPostSignupBootstrap(db, {
      userId: "first-human",
      email: "h@example.com",
    });
    expect(result.promotedToInstanceAdmin).toBe(true);
    expect(await countHumanAdmins()).toBe(1);
  });

  it("idempotent: re-running bootstrap for the same user is a no-op", async () => {
    const r1 = await runPostSignupBootstrap(db, { userId: "founder", email: "f@example.com" });
    expect(r1.promotedToInstanceAdmin).toBe(true);

    // Replay (could happen if the better-auth user.create hook AND the Supabase
    // webhook both fire for the same account — pre-2026-05-03 wiring).
    const r2 = await runPostSignupBootstrap(db, { userId: "founder", email: "f@example.com" });
    expect(r2.promotedToInstanceAdmin).toBe(false);
    expect(await countHumanAdmins()).toBe(1);
  });

  // Council 2026-05-04 — auth-mirror PR.
  //
  // Pre-fix, Supabase signups never landed in public."user" — every code
  // path that joined on authUsers (welcome emails, weekly wraps, board API
  // key lookup) silently saw an empty mirror. Bootstrap now upserts the
  // user row as its first step so the rest of the app has identity to
  // join against.
  it("mirror upsert: first signup creates a public.\"user\" row from JWT identity", async () => {
    await runPostSignupBootstrap(db, {
      userId: "founder-mirror-1",
      email: "founder@example.com",
      name: "Founder Mirror",
    });

    const userRow = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
      })
      .from(authUsers)
      .where(eq(authUsers.id, "founder-mirror-1"))
      .then((rows) => rows[0] ?? null);

    expect(userRow).not.toBeNull();
    expect(userRow?.email).toBe("founder@example.com");
    expect(userRow?.name).toBe("Founder Mirror");
  });

  it("mirror upsert: missing name falls back to email local-part", async () => {
    await runPostSignupBootstrap(db, {
      userId: "founder-mirror-2",
      email: "noname@example.com",
    });

    const userRow = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, "founder-mirror-2"))
      .then((rows) => rows[0] ?? null);

    expect(userRow?.name).toBe("noname");
  });

  it("mirror upsert: re-running does NOT clobber an explicit name set later", async () => {
    // First signup with a JWT-derived name.
    await runPostSignupBootstrap(db, {
      userId: "founder-mirror-3",
      email: "later@example.com",
      name: "JWT Default",
    });

    // User goes to their profile and sets a custom name.
    await db
      .update(authUsers)
      .set({ name: "User Picked This" })
      .where(eq(authUsers.id, "founder-mirror-3"));

    // Replay (e.g., second login fires the bootstrap path again).
    await runPostSignupBootstrap(db, {
      userId: "founder-mirror-3",
      email: "later@example.com",
      name: "JWT Default",
    });

    const userRow = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, "founder-mirror-3"))
      .then((rows) => rows[0] ?? null);

    // onConflictDoNothing means the user-picked name survives.
    expect(userRow?.name).toBe("User Picked This");
  });

  it("FK cascade: deleting a user row wipes their role row automatically", async () => {
    await runPostSignupBootstrap(db, {
      userId: "founder-cascade",
      email: "cascade@example.com",
    });
    expect(await countHumanAdmins()).toBe(1);

    // Simulate a user being removed from the auth source. Pre-fix, the
    // role row would survive as an orphan and brick first-user-wins
    // promotion for everyone after. Post-fix, the FK wipes it cleanly.
    await db.delete(authUsers).where(eq(authUsers.id, "founder-cascade"));

    expect(await countHumanAdmins()).toBe(0);

    // The next founder can now be promoted because no orphan blocks them.
    const result = await runPostSignupBootstrap(db, {
      userId: "next-founder",
      email: "next@example.com",
    });
    expect(result.promotedToInstanceAdmin).toBe(true);
  });
});
