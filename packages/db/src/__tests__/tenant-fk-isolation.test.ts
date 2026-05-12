/**
 * tenant-fk-isolation.test.ts — Drizzle schema integrity test
 *
 * Background — 2026-05-04 production onboarding incident
 * ------------------------------------------------------
 * Pre-2026-05-04, `instance_user_roles.user_id` had NO foreign key to
 * `public."user"`. When a Supabase signup never mirrored into the app-side
 * `public."user"` table, an orphan role row could exist that pointed at a
 * non-existent user. First-user-wins promotion then refused to complete
 * (the orphan looked like a real admin) and production onboarding was
 * bricked until manual cleanup. The fix was twofold:
 *   1. Mirror the Supabase user into `public."user"` on first authenticated
 *      request (`runPostSignupBootstrap` in server/src/auth/post-signup-hook.ts).
 *   2. Add `FK (user_id) REFERENCES "user"(id) ON DELETE CASCADE` so a
 *      missing parent row is impossible by construction (migration 0073).
 *
 * See packages/db/src/schema/instance_user_roles.ts for the canonical pattern.
 *
 * This test is the structural backstop. It walks every Drizzle table in
 * `packages/db/src/schema/` and asserts that any column literally named
 * `user_id` (the principal-user pattern, not the audit pattern) carries
 * a FK to the `"user"` table with `onDelete === "cascade"`. Audit-style
 * columns (`created_by_user_id`, `actor_user_id`, etc.) are out of scope
 * by name — those intentionally retain references after user deletion.
 *
 * Tenant scope: FounderOS is single-instance by design today (no
 * `instances` table; no `instance_id` / `tenant_id` columns). The tenant
 * loop is included so that the FIRST table to introduce a multi-tenant
 * column will trip this test if it forgets the FK — same protection
 * shape as the 2026-05-04 user-FK fix, ahead of the next migration.
 *
 * Failure means: a new table is silently allowing orphan rows. Either
 *   (a) add the missing FK + ON DELETE behavior to the schema, OR
 *   (b) add the table to the allowlist below WITH a justification comment
 *       citing the audit/retention reason.
 */
import { describe, expect, it } from "vitest";
import {
  getTableConfig,
  PgTable,
} from "drizzle-orm/pg-core";
import { getTableName, is } from "drizzle-orm";
import * as schema from "../schema/index.js";

// ---------------------------------------------------------------------------
// Allowlist — tables whose `user_id`-shaped column intentionally lacks a FK
// to `public."user"`. Each entry MUST cite a concrete justification.
// ---------------------------------------------------------------------------
//
// To add a table here: prove the column is audit/retention-style (the row
// should outlive the referenced user) OR document the cross-system reason
// the FK can't exist. Otherwise: add the FK in a migration and don't
// allowlist.
const USER_FK_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // composio_connections.user_id is a FounderOS board user id stored as
  // free-form text so the row survives an auth-provider swap (per the
  // table's own header comment in composio_connections.ts L20-L25).
  // Access is enforced at the route layer via `requireCompanyAccess`,
  // not via DB FK. Tenant isolation is still hard — company_id FK ON
  // DELETE CASCADE removes the row on company deletion.
  ["composio_connections", "auth-provider-swap durability; route-level access check"],

  // issue_inbox_archives.user_id, issue_read_states.user_id,
  // inbox_dismissals.user_id are per-user UI state tables. They predate
  // the 2026-05-04 user-mirror fix and use free-form user ids. Rows are
  // safe-orphan: dangling user reference produces stale UI state, not a
  // security failure or a stuck-state bug. Tracked for retrofit but not
  // a blocker for the structural test. company_id FK + ON DELETE CASCADE
  // already prevents rows surviving company deletion.
  ["issue_inbox_archives", "pre-2026-05-04 per-user UI state; safe-orphan semantics"],
  ["issue_read_states", "pre-2026-05-04 per-user UI state; safe-orphan semantics"],
  ["inbox_dismissals", "pre-2026-05-04 per-user UI state; safe-orphan semantics"],
]);

// Tenant-scope columns we'd assert against `instances` if any existed.
// Keep this list explicit so reviewers can see exactly what we look for.
const TENANT_COLUMN_NAMES = new Set(["instance_id", "tenant_id"]);

// The principal-user column name. Audit columns (`created_by_user_id`,
// `actor_user_id`, etc.) are NOT in this set — those intentionally outlive
// the referenced user and are out of scope.
const USER_PRINCIPAL_COLUMN_NAMES = new Set(["user_id"]);

interface SchemaTable {
  table: PgTable;
  tableName: string;
}

function enumerateTables(): SchemaTable[] {
  const tables: SchemaTable[] = [];
  for (const exported of Object.values(schema as Record<string, unknown>)) {
    if (exported && typeof exported === "object" && is(exported, PgTable)) {
      const table = exported as PgTable;
      tables.push({ table, tableName: getTableName(table) });
    }
  }
  return tables;
}

interface ForeignKeyInfo {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string | undefined;
  onUpdate: string | undefined;
}

function describeForeignKeys(table: PgTable): ForeignKeyInfo[] {
  const cfg = getTableConfig(table);
  return cfg.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      foreignTable: getTableName(ref.foreignTable),
      foreignColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    };
  });
}

describe("schema integrity: tenant-and-user foreign key isolation", () => {
  const tables = enumerateTables();

  it("enumerates at least one Drizzle table (sanity)", () => {
    // If this assertion fires, the schema export surface has changed in a
    // way that defeats the integrity walk. Investigate before adjusting.
    expect(tables.length).toBeGreaterThan(20);
  });

  it("every column named instance_id / tenant_id has a FK to `instances`", () => {
    const violations: string[] = [];
    let tenantColumnCount = 0;

    for (const { table, tableName } of tables) {
      const cfg = getTableConfig(table);
      const fks = describeForeignKeys(table);

      for (const column of cfg.columns) {
        if (!TENANT_COLUMN_NAMES.has(column.name)) continue;
        tenantColumnCount += 1;

        const matchingFk = fks.find(
          (fk) => fk.columns.length === 1 && fk.columns[0] === column.name,
        );

        if (!matchingFk) {
          violations.push(
            `${tableName}.${column.name}: tenant-scoped column has no foreign key`,
          );
          continue;
        }

        if (matchingFk.foreignTable !== "instances") {
          violations.push(
            `${tableName}.${column.name}: FK targets "${matchingFk.foreignTable}", expected "instances"`,
          );
        }
      }
    }

    // Finding (informational): FounderOS is single-instance today. If this
    // count is 0, that's the expected state pre-multi-tenant. If a future
    // migration introduces an instance-scoped column without an FK, the
    // violations array above will surface it.
    if (tenantColumnCount === 0) {
      // No-op: documented single-instance state.
    }

    expect(violations).toEqual([]);
  });

  it("every column literally named user_id has a FK to `user` with ON DELETE CASCADE", () => {
    const violations: string[] = [];
    let principalUserColumnCount = 0;

    for (const { table, tableName } of tables) {
      const cfg = getTableConfig(table);
      const fks = describeForeignKeys(table);

      for (const column of cfg.columns) {
        if (!USER_PRINCIPAL_COLUMN_NAMES.has(column.name)) continue;
        principalUserColumnCount += 1;

        const allowReason = USER_FK_ALLOWLIST.get(tableName);
        const matchingFk = fks.find(
          (fk) => fk.columns.length === 1 && fk.columns[0] === column.name,
        );

        // Allowlisted: skip both presence + cascade checks but require the
        // entry exist (above lookup) so reviewers see the explicit waiver.
        if (allowReason) {
          // Sanity: an allowlisted table must NOT also carry a FK pointing
          // at the user table — that would be confusing. (If they want a
          // FK they should remove the allowlist entry.)
          const userFk = fks.find(
            (fk) =>
              fk.columns.includes(column.name) && fk.foreignTable === "user",
          );
          if (userFk) {
            violations.push(
              `${tableName}.${column.name}: allowlisted but ALSO has FK to "user" — remove allowlist entry`,
            );
          }
          continue;
        }

        if (!matchingFk) {
          violations.push(
            `${tableName}.${column.name}: user-scoped column has no foreign key (add FK → "user" ON DELETE CASCADE, or allowlist with justification)`,
          );
          continue;
        }

        if (matchingFk.foreignTable !== "user") {
          violations.push(
            `${tableName}.${column.name}: FK targets "${matchingFk.foreignTable}", expected "user"`,
          );
          continue;
        }

        if (matchingFk.onDelete !== "cascade") {
          violations.push(
            `${tableName}.${column.name}: FK to "user" has onDelete="${matchingFk.onDelete ?? "<none>"}", expected "cascade" (2026-05-04 incident)`,
          );
        }
      }
    }

    // Sanity check: we should be observing the principal-user column at
    // least once (instance_user_roles is the canonical example). If this
    // drops to zero, the walk is broken.
    expect(principalUserColumnCount).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("allowlist entries correspond to real tables (no stale waivers)", () => {
    const tableNamesSet = new Set(tables.map((t) => t.tableName));
    const stale: string[] = [];
    for (const allowlistedName of USER_FK_ALLOWLIST.keys()) {
      if (!tableNamesSet.has(allowlistedName)) {
        stale.push(allowlistedName);
      }
    }
    expect(stale).toEqual([]);
  });

  it("allowlist entries actually have a user_id column (no misnomers)", () => {
    const lookup = new Map(tables.map((t) => [t.tableName, t.table] as const));
    const wrong: string[] = [];
    for (const allowlistedName of USER_FK_ALLOWLIST.keys()) {
      const table = lookup.get(allowlistedName);
      if (!table) continue; // covered by the previous test
      const cfg = getTableConfig(table);
      const hasUserId = cfg.columns.some((c) =>
        USER_PRINCIPAL_COLUMN_NAMES.has(c.name),
      );
      if (!hasUserId) {
        wrong.push(allowlistedName);
      }
    }
    expect(wrong).toEqual([]);
  });
});
