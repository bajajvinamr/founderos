/**
 * events-dedup-key-not-null.test.ts — Loop 2 L2-D25, structural invariant defense
 *
 * Locks the `events.dedup_key NOT NULL` contract at three layers so a future
 * "soften the column" or "drop the runtime guard" regression fails CI loudly
 * instead of recreating the silent dedup-loss footgun the council called out.
 *
 * Cites:
 *   - Council R2 PASS, 2026-05-05 — `events` table requires `dedup_key NOT NULL`.
 *     Sources without a natural id MUST compute a synthetic key (Slack →
 *     `${channelId}:${ts}`; PostHog when id missing → `synth:${eventName}:${ts}:${distinctId ?? "anon"}`;
 *     HubSpot/LinkedIn → source id directly). Don't pass `null` or `""` —
 *     `event-ingest.ts` runtime-guards both and throws.
 *   - vinamr-invariants.staging.md, Postgres: `UNIQUE` + `ON CONFLICT DO NOTHING`
 *     with a NULLABLE dedup column is a silent dedup-loss vector. Default
 *     `NULLS DISTINCT` semantics mean two NULL rows never collide; every retry
 *     inserts a duplicate. Fix: `NOT NULL` on the dedup column (preferred) OR
 *     `UNIQUE NULLS NOT DISTINCT`. We chose NOT NULL — this test guards that.
 *
 * Asserts:
 *   (1) Drizzle schema: `events.dedupKey.notNull === true`, column type is
 *       PgText, DB column name is `dedup_key`.
 *   (2) Migration SQL `0077_events.sql` declares `"dedup_key" text NOT NULL`.
 *   (3) `eventIngestService(db).ingestEvent` throws synchronously-on-await when
 *       `dedupKey` is `null` (cast through `any` because TS would otherwise
 *       refuse to compile a null in the typed contract — the runtime guard is
 *       defense-in-depth against callers who bypass types via raw SQL paths,
 *       `as any` shims, or future code that loosens the input shape).
 *   (4) `eventIngestService(db).ingestEvent` throws when `dedupKey` is `""`.
 *   (5) Unique-collision-shape: the `events_dedup_unique` UNIQUE on
 *       (company_id, source, dedup_key) is paired with `dedup_key NOT NULL`,
 *       which is sufficient on its own — `NULLS NOT DISTINCT` is not required
 *       (and Drizzle reports `nullsNotDistinct: false`). This test pins the
 *       invariant "either the column is NOT NULL or the UNIQUE is NULLS NOT
 *       DISTINCT" so a future relaxation must satisfy at least one branch.
 *
 * Hard-boundary note: this test deliberately uses a `null` mock db that
 * NEVER reaches SQL — the runtime guard short-circuits before db is touched.
 * No embedded Postgres needed, so this runs in any CI environment.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { events } from "@founderos/db";
import type { Db } from "@founderos/db";
import { eventIngestService } from "../event-ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/src/services/__tests__/events-dedup-key-not-null.test.ts
//   → repo root → packages/db/src/migrations/0077_events.sql
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../packages/db/src/migrations/0077_events.sql",
);

function readMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf8");
}

describe("events.dedup_key NOT NULL — structural invariant (L2-D25)", () => {
  // ── (1) Drizzle schema ────────────────────────────────────────────────────

  it("(1) Drizzle column config marks dedup_key as NOT NULL text", () => {
    const cols = getTableColumns(events);
    expect(cols.dedupKey, "events.dedupKey must exist in Drizzle schema").toBeDefined();
    expect(cols.dedupKey.name).toBe("dedup_key");
    expect(cols.dedupKey.notNull).toBe(true);
    expect(cols.dedupKey.columnType).toBe("PgText");
    expect(cols.dedupKey.dataType).toBe("string");
  });

  // ── (2) Migration SQL ─────────────────────────────────────────────────────

  it("(2) migration 0077_events.sql declares dedup_key TEXT NOT NULL", () => {
    const sql = readMigration();
    // Tolerate whitespace variation, but require the three load-bearing tokens
    // in order on the same column declaration: "dedup_key" + text + NOT NULL.
    const dedupKeyDecl = /"dedup_key"\s+text\s+NOT\s+NULL/i;
    expect(
      dedupKeyDecl.test(sql),
      `migration must declare "dedup_key" text NOT NULL; got: ${sql.match(/"dedup_key"[^,\n]*/i)?.[0] ?? "no match"}`,
    ).toBe(true);
  });

  it("(2b) migration 0077_events.sql declares UNIQUE on (company_id, source, dedup_key)", () => {
    const sql = readMigration();
    // The UNIQUE constraint is the collision-detection mechanism that the
    // NOT NULL guard makes safe. Without the UNIQUE, dedup_key is just a
    // dangling column. Pin the constraint shape too.
    const uniqueDecl = /UNIQUE\s*\(\s*"company_id"\s*,\s*"source"\s*,\s*"dedup_key"\s*\)/i;
    expect(uniqueDecl.test(sql), "migration must declare UNIQUE (company_id, source, dedup_key)").toBe(true);
  });

  // ── (3) Runtime guard — null ──────────────────────────────────────────────

  it("(3) ingestEvent throws on dedupKey: null before reaching SQL", async () => {
    // `null as never as Db` produces a mock db that would throw "Cannot read
    // properties of null (reading 'insert')" if the guard ever fell through.
    // The test passing means the guard short-circuited first — db was never
    // touched. This is exactly the defense-in-depth shape we want to prove.
    const svc = eventIngestService(null as unknown as Db);

    await expect(
      svc.ingestEvent({
        companyId: "00000000-0000-0000-0000-000000000000",
        source: "slack",
        entityType: "message",
        eventName: "message.posted",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dedupKey: null as any,
        occurredAt: new Date("2026-05-05T00:00:00Z"),
        payload: { text: "null key" },
      }),
    ).rejects.toThrow(/dedupKey is required/);
  });

  // ── (4) Runtime guard — empty string ──────────────────────────────────────

  it("(4) ingestEvent throws on dedupKey: \"\" before reaching SQL", async () => {
    const svc = eventIngestService(null as unknown as Db);

    await expect(
      svc.ingestEvent({
        companyId: "00000000-0000-0000-0000-000000000000",
        source: "slack",
        entityType: "message",
        eventName: "message.posted",
        dedupKey: "",
        occurredAt: new Date("2026-05-05T00:00:00Z"),
        payload: { text: "empty key" },
      }),
    ).rejects.toThrow(/dedupKey is required/);
  });

  it("(4b) ingestEvent throws on whitespace-only dedupKey", async () => {
    const svc = eventIngestService(null as unknown as Db);

    await expect(
      svc.ingestEvent({
        companyId: "00000000-0000-0000-0000-000000000000",
        source: "slack",
        entityType: "message",
        eventName: "message.posted",
        dedupKey: "   \t  \n",
        occurredAt: new Date("2026-05-05T00:00:00Z"),
        payload: { text: "whitespace key" },
      }),
    ).rejects.toThrow(/dedupKey is required/);
  });

  // ── (5) UNIQUE constraint shape ───────────────────────────────────────────

  it("(5) UNIQUE collision shape is safe: column NOT NULL OR index NULLS NOT DISTINCT", () => {
    const cfg = getTableConfig(events);
    const dedupUnique = cfg.uniqueConstraints?.find(
      (u) => u.columns.some((c) => c.name === "dedup_key"),
    );
    expect(dedupUnique, "events_dedup_unique must exist").toBeDefined();

    const cols = getTableColumns(events);
    const dedupKeyNotNull = cols.dedupKey.notNull === true;
    const nullsNotDistinct = dedupUnique!.nullsNotDistinct === true;

    // Either branch is sufficient to prevent the silent-dedup-loss class.
    // Today's truth is: column is NOT NULL, NULLS NOT DISTINCT is false.
    // A future refactor that flips one MUST keep the other set.
    expect(
      dedupKeyNotNull || nullsNotDistinct,
      `events_dedup_unique must be paired with EITHER dedup_key NOT NULL OR ` +
        `NULLS NOT DISTINCT; got notNull=${dedupKeyNotNull} nullsNotDistinct=${nullsNotDistinct}. ` +
        `See council R2 PASS 2026-05-05 and vinamr-invariants Postgres section.`,
    ).toBe(true);
  });
});
