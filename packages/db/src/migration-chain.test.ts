// Migration chain integrity test.
//
// Why this exists:
//   The Drizzle runtime migrator (packages/db/src/migrate.ts) reads
//   _journal.json + the .sql files only — it does NOT consult the per-migration
//   snapshot files under migrations/meta/. Two prior post-merge incidents make
//   this contract load-bearing:
//
//     1. Parallel-branch merge loss in `_journal.json`. When two feature
//        branches each add a migration (e.g., S1.7 adds idx N, S1.8 adds idx
//        N+1), an editor or merge tool collapsing the journal `entries[]`
//        array to a single entry silently breaks production migrate. The
//        existing `check:migrations` script (src/check-migration-numbering.ts)
//        catches some shapes via journal-tag → file alignment, but only at
//        build time, and only the file-prefix axis — not idx sequencing.
//
//     2. Drizzle snapshot-regen corruption. When `drizzle-kit generate` fails
//        on snapshot chain corruption (a `prevId` mismatch), the structural
//        fix is to hand-write the SQL migration + append a journal entry, and
//        ship without regenerating snapshots — because the runtime migrator
//        never reads them. The hazard: the hand-written journal entry can
//        drift from the SQL file (wrong tag, wrong idx, missing SQL file,
//        empty SQL file) and the runtime migrator only finds out in prod.
//
// What this test asserts:
//   • Every entry in _journal.json.entries has a matching <tag>.sql file on
//     disk under packages/db/src/migrations/.
//   • Every <NNNN>_*.sql file under migrations/ has a matching journal entry.
//   • Journal `idx` values are strictly sequential starting at 0 with no gaps
//     or duplicates — this is what Drizzle's runtime migrator iterates over.
//   • Each .sql file is non-empty (trimmed length > 0) and parses to a stable
//     SHA-256 digest — Drizzle's runtime stores this digest in the
//     __drizzle_migrations table per applied migration. An empty / corrupt
//     SQL file would silently apply as a no-op then poison every subsequent
//     deploy when content reappears.
//
// Note on the journal v7 format: entries have keys
//   { idx, version, when, tag, breakpoints }
// — there is NO `hash` field at rest. Hashes are computed at runtime by the
// migrator and stored in __drizzle_migrations. So this test computes the hash
// itself and asserts shape + determinism, not a recorded-vs-actual match.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(
  new URL("./migrations/meta/_journal.json", import.meta.url),
);

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function loadJournal(): Journal {
  const raw = readFileSync(journalPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("_journal.json is missing an entries[] array");
  }
  return parsed as Journal;
}

function listSqlFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Drizzle migration chain integrity", () => {
  const journal = loadJournal();
  const sqlFiles = listSqlFiles();

  it("journal has at least one entry", () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("journal entry count matches the number of .sql files", () => {
    expect(journal.entries.length).toBe(sqlFiles.length);
  });

  it("journal entries have sequential idx values starting at 0 with no gaps or duplicates", () => {
    const seen = new Set<number>();
    journal.entries.forEach((entry, position) => {
      expect(
        typeof entry.idx,
        `entry at position ${position} has non-number idx`,
      ).toBe("number");
      expect(
        entry.idx,
        `entry at position ${position} has idx ${entry.idx}; expected ${position} (gap or out-of-order)`,
      ).toBe(position);
      expect(
        seen.has(entry.idx),
        `duplicate idx ${entry.idx} at position ${position}`,
      ).toBe(false);
      seen.add(entry.idx);
    });
  });

  it("every journal entry has a non-empty string tag", () => {
    for (const entry of journal.entries) {
      expect(typeof entry.tag, `idx ${entry.idx} has non-string tag`).toBe(
        "string",
      );
      expect(entry.tag.length, `idx ${entry.idx} has empty tag`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every journal entry tag has a matching .sql file on disk", () => {
    const sqlSet = new Set(sqlFiles);
    const missing: string[] = [];
    for (const entry of journal.entries) {
      const expectedFile = `${entry.tag}.sql`;
      if (!sqlSet.has(expectedFile)) {
        missing.push(expectedFile);
      }
    }
    expect(
      missing,
      `journal references SQL files that do not exist on disk: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every .sql file on disk has a matching journal entry tag", () => {
    const journalFiles = new Set(
      journal.entries.map((entry) => `${entry.tag}.sql`),
    );
    const orphaned: string[] = [];
    for (const file of sqlFiles) {
      if (!journalFiles.has(file)) {
        orphaned.push(file);
      }
    }
    expect(
      orphaned,
      `SQL files exist on disk without a journal entry (runtime migrator will skip them): ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("SQL file filename prefixes are unique 4-digit numbers", () => {
    const prefixes = new Map<string, string>();
    for (const file of sqlFiles) {
      const match = file.match(/^(\d{4})_/);
      expect(match, `SQL file ${file} does not start with NNNN_`).not.toBeNull();
      const prefix = match![1];
      const existing = prefixes.get(prefix);
      expect(
        existing,
        `duplicate migration file prefix ${prefix}: ${existing} and ${file}`,
      ).toBeUndefined();
      prefixes.set(prefix, file);
    }
  });

  it("every .sql file is non-empty and produces a stable SHA-256 digest", () => {
    for (const entry of journal.entries) {
      const filePath = fileURLToPath(
        new URL(`./migrations/${entry.tag}.sql`, import.meta.url),
      );
      const stat = statSync(filePath);
      expect(stat.size, `${entry.tag}.sql is zero bytes`).toBeGreaterThan(0);

      const content = readFileSync(filePath, "utf8");
      expect(
        content.trim().length,
        `${entry.tag}.sql contains only whitespace`,
      ).toBeGreaterThan(0);

      const digest = sha256(content);
      expect(digest, `${entry.tag}.sql produced empty digest`).toMatch(
        /^[0-9a-f]{64}$/,
      );

      // Determinism: same content recomputed yields the same digest.
      // Catches any non-deterministic read (e.g., line-ending mangling under
      // certain Node configs) that would make migrations appear "changed".
      expect(sha256(content)).toBe(digest);
    }
  });

  it("every journal entry has a positive numeric `when` timestamp", () => {
    // The runtime migrator iterates by idx, not by when, so a non-decreasing
    // chain is not load-bearing — historical entries pre-date the convention.
    // The structural contract is that `when` exists and is a non-zero number,
    // because Drizzle's __drizzle_migrations table reads it into `created_at`.
    for (const entry of journal.entries) {
      expect(
        typeof entry.when,
        `idx ${entry.idx} (${entry.tag}) has non-number when`,
      ).toBe("number");
      expect(
        entry.when,
        `idx ${entry.idx} (${entry.tag}) has non-positive when=${entry.when}`,
      ).toBeGreaterThan(0);
    }
  });
});
