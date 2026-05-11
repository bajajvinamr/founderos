/**
 * Orphaned-workdir sweep service.
 *
 * Phase S8 P0.1 — Council R1 condition C6.
 *
 * After Phase 1C lands per-job workdirs (`/founderos/agents/<companyId>/<runId>/`),
 * the persistent volume can fill up if a runner crashes mid-job or a job exits
 * without cleaning up its workdir. This service walks the root, deletes any
 * `<companyId>/<runId>/` directory whose mtime is older than `maxAgeMs` (default
 * 24h), and is forward-compatible: if the root doesn't exist yet (Phase 1C not
 * landed, or fresh env), it no-ops cleanly.
 *
 * Wired at boot (after `ensureMigrations`, before `app.listen`) and on a 6-hour
 * `setInterval` for long-running servers.
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";

export const DEFAULT_WORKDIR_ROOT = "/founderos/agents";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export interface SweepOptions {
  rootDir?: string;
  maxAgeMs?: number;
  /**
   * Defaults to `Date.now`. Injectable for tests.
   */
  now?: () => number;
}

export interface SweepResult {
  scanned: number;
  deleted: number;
  errors: number;
  rootMissing: boolean;
}

interface ListedEntry {
  fullPath: string;
  companyId: string;
  runId: string;
}

async function listRunDirs(rootDir: string): Promise<ListedEntry[]> {
  const out: ListedEntry[] = [];
  let companyEntries: Dirent[];
  try {
    companyEntries = (await fs.readdir(rootDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const companyEntry of companyEntries) {
    if (!companyEntry.isDirectory()) continue;
    const companyName = String(companyEntry.name);
    const companyPath = path.join(rootDir, companyName);
    let runEntries: Dirent[];
    try {
      runEntries = (await fs.readdir(companyPath, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      const runName = String(runEntry.name);
      out.push({
        fullPath: path.join(companyPath, runName),
        companyId: companyName,
        runId: runName,
      });
    }
  }
  return out;
}

/**
 * Walk `<rootDir>/<companyId>/<runId>/` and delete any whose mtime is older
 * than `now - maxAgeMs`. Returns a structured result for logging / metrics.
 *
 * Never throws on a missing root dir (returns `rootMissing: true`). Per-entry
 * errors (stat / rm failures) are logged + counted but do not abort the sweep.
 */
export async function sweepOrphanedWorkdirs(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const rootDir = opts.rootDir ?? DEFAULT_WORKDIR_ROOT;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = opts.now ?? Date.now;

  const result: SweepResult = {
    scanned: 0,
    deleted: 0,
    errors: 0,
    rootMissing: false,
  };

  let entries: ListedEntry[];
  try {
    entries = await listRunDirs(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      result.rootMissing = true;
      logger.debug(
        { rootDir },
        "orphaned-workdir-sweep: root dir missing — no-op",
      );
      return result;
    }
    logger.error({ err, rootDir }, "orphaned-workdir-sweep: failed to list root");
    result.errors += 1;
    return result;
  }

  // If listRunDirs returned [] because the root itself doesn't exist, mark it.
  // (listRunDirs swallows ENOENT on the root readdir; reflect that here.)
  try {
    await fs.access(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      result.rootMissing = true;
      logger.debug(
        { rootDir },
        "orphaned-workdir-sweep: root dir missing — no-op",
      );
      return result;
    }
  }

  const cutoff = now() - maxAgeMs;

  for (const entry of entries) {
    result.scanned += 1;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(entry.fullPath);
      mtimeMs = stat.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      logger.warn(
        { err, path: entry.fullPath },
        "orphaned-workdir-sweep: stat failed, skipping",
      );
      result.errors += 1;
      continue;
    }

    if (mtimeMs >= cutoff) continue; // recent — skip

    try {
      await fs.rm(entry.fullPath, { recursive: true, force: true });
      result.deleted += 1;
    } catch (err) {
      logger.warn(
        { err, path: entry.fullPath },
        "orphaned-workdir-sweep: delete failed, skipping",
      );
      result.errors += 1;
    }
  }

  if (result.scanned > 0 || result.deleted > 0) {
    logger.info(
      {
        rootDir,
        maxAgeMs,
        scanned: result.scanned,
        deleted: result.deleted,
        errors: result.errors,
      },
      `orphaned-workdir-sweep: deleted ${result.deleted} of ${result.scanned} workdir(s)`,
    );
  }

  return result;
}

/**
 * Schedule a recurring sweep on `setInterval`. Returns the timer so callers
 * can `clearInterval` (e.g. for graceful shutdown or tests). The first sweep
 * runs immediately (fire-and-forget); subsequent sweeps fire every `intervalMs`.
 */
export function scheduleOrphanedWorkdirSweep(
  opts: SweepOptions & { intervalMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  void sweepOrphanedWorkdirs(opts).catch((err) => {
    logger.error({ err }, "orphaned-workdir-sweep: initial sweep failed");
  });
  const timer = setInterval(() => {
    void sweepOrphanedWorkdirs(opts).catch((err) => {
      logger.error({ err }, "orphaned-workdir-sweep: interval sweep failed");
    });
  }, intervalMs);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
