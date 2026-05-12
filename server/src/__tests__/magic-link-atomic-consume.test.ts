/**
 * L2-D26 — magic-link atomic-consume structural defense (S6.7, 2026-05-06).
 *
 * This is a REGRESSION-DEFENSE test that pins:
 *   1. The schema invariants on `magic_link_tokens` (NOT NULL, UNIQUE on
 *      token_hash, CHECK constraints from migration 0101) via direct
 *      DB-catalog introspection, NOT via Drizzle's TS types (which erase
 *      at compile time and don't catch migration drift).
 *   2. The plaintext token is NOT stored anywhere in the row — only the
 *      sha256 hex hash.
 *   3. The runtime atomicity of `consume()` under concurrent invocation:
 *      Promise.all of two simultaneous consumes for the same plaintext
 *      MUST resolve with exactly one success and one failure. If a future
 *      refactor splits consume into SELECT-then-UPDATE for "readability"
 *      or "defensive logging", the race window reopens and BOTH calls
 *      succeed — this test catches that regression.
 *   4. The source code of `services/magic-link.ts` contains the single
 *      conditional UPDATE shape — `WHERE token_hash = ... AND
 *      consumed_at IS NULL AND expires_at > NOW()`. Pinning the source
 *      shape is the cheapest backstop against a "refactor for clarity"
 *      that silently reintroduces the TOCTOU race the council closed.
 *
 * Verbatim vinamr-invariant being defended (CLAUDE.md, S6.7, 2026-05-06):
 * > Magic-link tokens (`mlt_<48 alnum>`) are sha256-hashed at rest with
 * > atomic single-use consume. Same security pattern as `runner_tokens`:
 * > plaintext shown once at issuance, only the hash lives in
 * > `magic_link_tokens.token_hash`. `consume()` is a single conditional
 * > UPDATE — `WHERE token_hash = $1 AND consumed_at IS NULL AND
 * > expires_at > NOW() RETURNING ...` — which is TOCTOU-safe under
 * > concurrent requests (the second click sees zero rows updated and
 * > throws "consumed or expired"). Do NOT add a SELECT-then-UPDATE code
 * > path; it reintroduces the race. The schema also enforces
 * > (purpose='approve_action' OR target_ref_kind IS NOT NULL) via CHECK,
 * > so issuing a non-approval link without a ref kind fails at the DB.
 *
 * Companion to `server/src/__tests__/magic-link.test.ts` (S6.7 behavioral
 * tests). That file pins behavior; this file pins STRUCTURE so a future
 * refactor cannot quietly weaken the security shape while still passing
 * the behavioral suite (e.g. a SELECT-then-UPDATE pattern can pass single-
 * caller tests but lose under genuine concurrent load).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  authUsers,
  companies,
  createDb,
  magicLinkTokens,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  hashMagicLinkToken,
  magicLinkService,
} from "../services/magic-link.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAGIC_LINK_SERVICE_PATH = resolve(
  __dirname,
  "..",
  "services",
  "magic-link.ts",
);

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping magic-link atomic-consume tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("magic-link atomic-consume structural defense (L2-D26)", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof magicLinkService>;
  let companyA: string;
  let userA: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("magic-link-atomic");
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
      .values({ name: "Acme", slug: `acme-l2d26-${ts}`, issuePrefix: `MLD26${ts}` })
      .returning({ id: companies.id });
    companyA = c.id;

    const now = new Date();
    const [u] = await db
      .insert(authUsers)
      .values({
        id: `user-l2d26-${ts}`,
        name: "Founder",
        email: `founder-l2d26-${ts}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: authUsers.id });
    userA = u.id;
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. Schema invariants — DB-catalog introspection.
  //    Drizzle TS types erase at compile time; only the actual catalog can
  //    confirm the constraint exists at runtime.
  // ───────────────────────────────────────────────────────────────────────
  describe("schema invariants (information_schema introspection)", () => {
    it("token_hash exists, is NOT NULL, and is text", async () => {
      const cols = (await db.execute(sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'magic_link_tokens' AND column_name = 'token_hash'
      `)) as unknown as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>;
      expect(cols).toHaveLength(1);
      expect(cols[0].data_type).toBe("text");
      expect(cols[0].is_nullable).toBe("NO");
    });

    it("token_hash has a UNIQUE constraint (single access path)", async () => {
      // pg_indexes lists all indexes; we want one UNIQUE index that includes
      // token_hash. UNIQUE prevents collisions AND serves as the only path
      // to a row — defensive: never enumerate by id alone.
      const indexes = (await db.execute(sql`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'magic_link_tokens'
          AND indexdef ILIKE '%UNIQUE%'
          AND indexdef ILIKE '%token_hash%'
      `)) as unknown as Array<{ indexname: string; indexdef: string }>;
      expect(indexes.length).toBeGreaterThanOrEqual(1);
    });

    it("plaintext token is NOT stored anywhere — no 'token' column, only 'token_hash'", async () => {
      const cols = (await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'magic_link_tokens'
      `)) as unknown as Array<{ column_name: string }>;
      const names = cols.map((c) => c.column_name);
      expect(names).toContain("token_hash");
      // The literal 'token' column would be a plaintext storage smell —
      // a future refactor must NOT add it.
      expect(names).not.toContain("token");
      expect(names).not.toContain("plaintext_token");
      expect(names).not.toContain("token_plaintext");
    });

    it("consumed_at and expires_at columns exist with correct nullability", async () => {
      const cols = (await db.execute(sql`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'magic_link_tokens'
          AND column_name IN ('consumed_at', 'expires_at')
      `)) as unknown as Array<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>;
      const byName = new Map(cols.map((c) => [c.column_name, c]));
      expect(byName.get("consumed_at")?.is_nullable).toBe("YES");
      expect(byName.get("expires_at")?.is_nullable).toBe("NO");
      expect(byName.get("consumed_at")?.data_type).toMatch(/timestamp/);
      expect(byName.get("expires_at")?.data_type).toMatch(/timestamp/);
    });

    it("CHECK constraint enforces (purpose='approve_action' → target_ref_kind IS NOT NULL)", async () => {
      const checks = (await db.execute(sql`
        SELECT conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'magic_link_tokens' AND c.contype = 'c'
      `)) as unknown as Array<{ conname: string; def: string }>;

      const approveCheck = checks.find((c) =>
        c.conname.includes("approve_requires_ref"),
      );
      expect(approveCheck).toBeDefined();
      const def = approveCheck!.def.toLowerCase();
      // Verbatim contract from the invariant: approve_action without a ref
      // kind must fail at the DB level. The constraint def normalizes to
      // `((purpose <> 'approve_action') OR (target_ref_kind IS NOT NULL))`.
      expect(def).toContain("approve_action");
      expect(def).toContain("target_ref_kind");
      expect(def).toContain("is not null");
    });

    it("DB rejects raw INSERT of approve_action without target_ref_kind (CHECK is live)", async () => {
      await expect(
        db.execute(sql`
          INSERT INTO "magic_link_tokens"
            ("user_id", "company_id", "token_hash", "purpose", "expires_at")
          VALUES
            (${userA}, ${companyA}::uuid, 'd26-bypass-1'::text,
             'approve_action', NOW() + interval '1 hour')
        `),
      ).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Plaintext is NOT persisted (only sha256 hash).
  // ───────────────────────────────────────────────────────────────────────
  describe("plaintext token is NOT stored at rest", () => {
    it("only the sha256 hash hits the row; plaintext never appears in any column", async () => {
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

      // Row's hash column equals sha256(plaintext) — same function the
      // service uses on consume. Length is 64 hex chars.
      expect(row.tokenHash).toBe(hashMagicLinkToken(issued.token));
      expect(row.tokenHash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(row.tokenHash)).toBe(true);

      // Plaintext must not be found in ANY column of the row when JSON-
      // stringified — guards against a future schema field that silently
      // shadows the plaintext (e.g. a "last_known_value" debug column).
      const allColsConcat = JSON.stringify(row);
      expect(allColsConcat).not.toContain(issued.token);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Runtime atomicity — the load-bearing TOCTOU defense.
  // ───────────────────────────────────────────────────────────────────────
  describe("runtime atomicity (TOCTOU defense)", () => {
    it("consume() succeeds exactly once for a valid token", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const r = await service.consume(issued.token);
      expect(r).not.toBeNull();
      expect(r!.userId).toBe(userA);
      expect(r!.companyId).toBe(companyA);
      expect(r!.purpose).toBe("view_brief");
    });

    it("a second consume() of the same plaintext returns null (single-use)", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const first = await service.consume(issued.token);
      const second = await service.consume(issued.token);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it("an expired token fails to consume even on first attempt", async () => {
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });
      // Backdate expires_at into the past — the conditional UPDATE's
      // `expires_at > NOW()` clause must reject this.
      await db.execute(sql`
        UPDATE "magic_link_tokens"
        SET expires_at = NOW() - interval '1 hour'
        WHERE id = ${issued.id}::uuid
      `);

      const r = await service.consume(issued.token);
      expect(r).toBeNull();

      // Belt-and-suspenders: the row still has consumed_at NULL — we
      // didn't accidentally consume an expired row.
      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(sql`${magicLinkTokens.id} = ${issued.id}::uuid`);
      expect(row.consumedAt).toBeNull();
    });

    it("two simultaneous consume() calls — exactly ONE succeeds, the other returns null", async () => {
      // The core TOCTOU defense. If consume() is split into SELECT-then-
      // UPDATE in any future refactor, BOTH promises will resolve with a
      // non-null result and this test will fail. With the atomic
      // conditional UPDATE, the second UPDATE matches zero rows because
      // `consumed_at IS NULL` is already false by the time it commits.
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const [a, b] = await Promise.all([
        service.consume(issued.token, "10.0.0.1"),
        service.consume(issued.token, "10.0.0.2"),
      ]);

      const successes = [a, b].filter((x) => x !== null);
      const failures = [a, b].filter((x) => x === null);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // The successful row is consumed exactly once in the DB, with one
      // recorded consumer IP — proves only ONE write went through.
      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(sql`${magicLinkTokens.id} = ${issued.id}::uuid`);
      expect(row.consumedAt).not.toBeNull();
      expect(row.consumedByIp === "10.0.0.1" || row.consumedByIp === "10.0.0.2").toBe(
        true,
      );
    });

    it("ten simultaneous consume() calls — exactly ONE succeeds (load test)", async () => {
      // Amplified version of the concurrency test. With a SELECT-then-
      // UPDATE pattern under genuine parallel load, multiple SELECTs can
      // race and observe `consumed_at IS NULL` before any UPDATE commits,
      // and several would then proceed to UPDATE (the second clause of a
      // split would not refuse them). The single conditional UPDATE
      // forces serialization at the row level via Postgres' MVCC.
      const issued = await service.issue({
        userId: userA,
        companyId: companyA,
        purpose: "view_brief",
        ttlMinutes: 60,
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.consume(issued.token, `10.0.0.${i + 1}`),
        ),
      );

      const successes = results.filter((x) => x !== null);
      expect(successes).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Source-shape pin — the cheapest backstop.
  //    A behavioral test can pass even with a subtly-wrong implementation
  //    on a fast laptop; pinning the SQL shape in the source guards against
  //    a refactor that silently slips a SELECT-then-UPDATE in.
  // ───────────────────────────────────────────────────────────────────────
  describe("source-shape pin (services/magic-link.ts)", () => {
    const src = readFileSync(MAGIC_LINK_SERVICE_PATH, "utf8");
    const lower = src.toLowerCase();

    it("source contains the three atomic-claim predicates in the consume() UPDATE", async () => {
      // The conditional UPDATE must match on token_hash, only-if-unconsumed,
      // and only-if-not-expired. All three together are what makes the
      // operation TOCTOU-safe.
      expect(lower).toContain(".update(magiclinktokens)");
      expect(lower).toContain("eq(magiclinktokens.tokenhash");
      expect(lower).toContain("isnull(magiclinktokens.consumedat)");
      expect(lower).toMatch(/expires_at[\s\S]{0,40}>\s*now\(\)/);
      // .returning(...) shape — the row is surfaced from the UPDATE
      // itself, not re-queried after.
      expect(lower).toContain(".returning(");
    });

    it("source does NOT contain a SELECT-then-set-consumed-at code path (no TOCTOU re-entry)", async () => {
      // A future "refactor for clarity" might write:
      //   const row = await tx.select()...where(eq(tokenHash))...
      //   if (row.consumedAt) return null;
      //   await tx.update(...).set({ consumedAt: ... })...
      // That pattern is what this test forbids. Look for the smell: a
      // .set({ consumedAt: ... }) UPDATE that doesn't carry the
      // `isNull(consumedAt)` predicate in the same statement.
      //
      // We allow the existing pattern (defense-in-depth SELECT for
      // re-verifying the hash with timing-safe compare BEFORE the atomic
      // UPDATE) — that SELECT does NOT itself decide to consume; the
      // UPDATE's WHERE clause does. The structural rule: every UPDATE
      // that sets consumedAt MUST be paired with isNull(consumedAt) in
      // its WHERE in the same builder chain.
      const updateChunks = src.split(/\.update\(magicLinkTokens\)/);
      // First chunk is everything BEFORE the first .update; subsequent
      // chunks are the call+chain after each .update(...). For every
      // post-.update chunk, look for the .set({ consumedAt ... }) and
      // check that an isNull(...consumedAt) follows before the next
      // .returning or top-level statement boundary.
      for (let i = 1; i < updateChunks.length; i++) {
        const chunk = updateChunks[i];
        const setIdx = chunk.search(/\.set\s*\(\s*\{[^}]*consumedAt/);
        if (setIdx === -1) continue; // this .update doesn't touch consumedAt
        // Look at the chunk up to .returning() — must contain isNull(...consumedAt).
        const upToReturning = chunk.split(/\.returning\s*\(/)[0];
        expect(upToReturning).toMatch(/isNull\s*\([^)]*consumedAt/);
      }
    });

    it("source comments preserve the TOCTOU contract (anti-regression marker)", async () => {
      // If someone strips the comments that explain "this is atomic — do
      // NOT split", the next agent is more likely to break it. Pin the
      // marker.
      expect(lower).toContain("toctou");
    });
  });
});
