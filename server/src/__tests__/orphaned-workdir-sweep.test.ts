import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sweepOrphanedWorkdirs } from "../services/orphaned-workdir-sweep.js";

const HOUR_MS = 60 * 60 * 1000;

async function makeWorkdir(
  root: string,
  companyId: string,
  runId: string,
  ageMs: number,
): Promise<string> {
  const dir = path.join(root, companyId, runId);
  await fs.mkdir(dir, { recursive: true });
  // Drop a marker file so the dir is non-empty and stat reflects the dir's own
  // mtime independently of children.
  await fs.writeFile(path.join(dir, "marker.txt"), "test\n");
  const target = new Date(Date.now() - ageMs);
  await fs.utimes(dir, target, target);
  return dir;
}

describe("sweepOrphanedWorkdirs", () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-sweep-test-"));
    // Spy on the logger module after it's already imported by the service.
    // We probe pino's `info` shape via dynamic import.
    const { logger } = await import("../middleware/logger.js");
    logSpy = vi.spyOn(logger, "info");
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("deletes a workdir whose mtime is 25h old", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const dir = await makeWorkdir(root, companyId, runId, 25 * HOUR_MS);

    const result = await sweepOrphanedWorkdirs({
      rootDir: root,
      maxAgeMs: 24 * HOUR_MS,
    });

    expect(result.deleted).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.rootMissing).toBe(false);

    await expect(fs.access(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a workdir whose mtime is 1h old", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const dir = await makeWorkdir(root, companyId, runId, 1 * HOUR_MS);

    const result = await sweepOrphanedWorkdirs({
      rootDir: root,
      maxAgeMs: 24 * HOUR_MS,
    });

    expect(result.deleted).toBe(0);
    expect(result.scanned).toBe(1);

    // Marker still readable.
    const marker = await fs.readFile(path.join(dir, "marker.txt"), "utf8");
    expect(marker).toBe("test\n");
  });

  it("handles missing root dir gracefully (no error thrown)", async () => {
    const missing = path.join(root, "does-not-exist");

    const result = await sweepOrphanedWorkdirs({
      rootDir: missing,
      maxAgeMs: 24 * HOUR_MS,
    });

    expect(result.rootMissing).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("does not delete a mid-flight runId workdir whose mtime is recent", async () => {
    const companyId = randomUUID();
    // One stale workdir + one mid-flight (recent) workdir under the same company.
    const staleRunId = randomUUID();
    const liveRunId = randomUUID();
    await makeWorkdir(root, companyId, staleRunId, 30 * HOUR_MS);
    const liveDir = await makeWorkdir(root, companyId, liveRunId, 5 * 60 * 1000); // 5min old

    const result = await sweepOrphanedWorkdirs({
      rootDir: root,
      maxAgeMs: 24 * HOUR_MS,
    });

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);

    // Live workdir survived intact.
    const marker = await fs.readFile(path.join(liveDir, "marker.txt"), "utf8");
    expect(marker).toBe("test\n");
    // Stale workdir was reaped.
    await expect(
      fs.access(path.join(root, companyId, staleRunId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs the count of deleted dirs", async () => {
    const companyId = randomUUID();
    await makeWorkdir(root, companyId, randomUUID(), 30 * HOUR_MS);
    await makeWorkdir(root, companyId, randomUUID(), 48 * HOUR_MS);
    await makeWorkdir(root, companyId, randomUUID(), 1 * HOUR_MS); // kept

    const result = await sweepOrphanedWorkdirs({
      rootDir: root,
      maxAgeMs: 24 * HOUR_MS,
    });

    expect(result.deleted).toBe(2);
    expect(result.scanned).toBe(3);

    // Pino logger.info(payload, message) — verify a summary line was emitted
    // referencing the deleted count.
    const matchingCalls = logSpy.mock.calls.filter((call) => {
      const arg0 = call[0];
      const msg = call[1];
      return (
        typeof arg0 === "object" &&
        arg0 !== null &&
        "deleted" in (arg0 as Record<string, unknown>) &&
        (arg0 as Record<string, unknown>).deleted === 2 &&
        typeof msg === "string" &&
        msg.includes("deleted 2")
      );
    });
    expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
  });
});
