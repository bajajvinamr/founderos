/**
 * workflow-autonomy.test.ts — Unit tests for the autonomy-gate predicates
 *
 * These tests exercise the pure-logic functions in workflow-autonomy.ts
 * without a real database. canRunAutonomously() queries instance_settings,
 * so we mock the Drizzle db handle. The integration tests in workflows.test.ts
 * cover the full path end-to-end with embedded PG.
 *
 * Covers:
 *   1. isDraftOnly: returns true for levels 1 and 2, false for 3 and 4
 *   2. requiresApproval: returns true only for level 3
 *   3. canRunAutonomously: level<4 always returns false (no DB read needed)
 *   4. canRunAutonomously: level=4 + flag=false → false
 *   5. canRunAutonomously: level=4 + flag=true → true
 *   6. canRunAutonomously: level=4 + flag='true' (string) → false (strict ===)
 *   7. canRunAutonomously: level=4 + no instance_settings row → false
 *   8. describeAutonomyLevel: correct labels for all 4 levels
 *   9. autonomyGateSummary: correct shape for level=2
 *  10. autonomyGateSummary: correct shape for level=3
 */

import { describe, expect, it, vi, type Mock } from "vitest";
import {
  isDraftOnly,
  requiresApproval,
  canRunAutonomously,
  describeAutonomyLevel,
  autonomyGateSummary,
  AUTONOMOUS_EMAIL_SETTING_KEY,
} from "../services/workflow-autonomy.js";
import { AUTONOMY_LEVELS } from "@founderos/db";
import type { Db } from "@founderos/db";

// ── Mock Drizzle DB ───────────────────────────────────────────────────────────

/**
 * Build a minimal mock Drizzle db that returns a given general JSONB value
 * when queried for instance_settings.
 *
 * The call chain in canRunAutonomously is:
 *   db.select({ general: instanceSettings.general })
 *     .from(instanceSettings)
 *     .where(...)
 *   → Promise<Array<{ general: Record<string, unknown> }>>
 *
 * We mock db.select() returning a chainable fluent object that resolves
 * to the supplied rows array.
 */
function makeDb(generalValue?: Record<string, unknown>): Db {
  const rows = generalValue !== undefined ? [{ general: generalValue }] : [];

  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };

  return {
    select: vi.fn().mockReturnValue(chain),
  } as unknown as Db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("isDraftOnly", () => {
  it("(1) returns true for level 1 (observe)", () => {
    expect(isDraftOnly({ autonomyLevel: AUTONOMY_LEVELS.OBSERVE })).toBe(true);
  });

  it("(1) returns true for level 2 (draft)", () => {
    expect(isDraftOnly({ autonomyLevel: AUTONOMY_LEVELS.DRAFT })).toBe(true);
  });

  it("(1) returns false for level 3 (approval-required)", () => {
    expect(isDraftOnly({ autonomyLevel: AUTONOMY_LEVELS.APPROVAL_REQUIRED })).toBe(false);
  });

  it("(1) returns false for level 4 (autonomous)", () => {
    expect(isDraftOnly({ autonomyLevel: AUTONOMY_LEVELS.AUTONOMOUS })).toBe(false);
  });
});

describe("requiresApproval", () => {
  it("(2) returns true only for level 3", () => {
    expect(requiresApproval({ autonomyLevel: AUTONOMY_LEVELS.OBSERVE })).toBe(false);
    expect(requiresApproval({ autonomyLevel: AUTONOMY_LEVELS.DRAFT })).toBe(false);
    expect(requiresApproval({ autonomyLevel: AUTONOMY_LEVELS.APPROVAL_REQUIRED })).toBe(true);
    expect(requiresApproval({ autonomyLevel: AUTONOMY_LEVELS.AUTONOMOUS })).toBe(false);
  });
});

describe("canRunAutonomously", () => {
  it("(3) levels 1-3 return false without making a DB call", async () => {
    // The DB mock tracks whether select() was called.
    const db = makeDb();
    expect(await canRunAutonomously(db, { autonomyLevel: 1 })).toBe(false);
    expect(await canRunAutonomously(db, { autonomyLevel: 2 })).toBe(false);
    expect(await canRunAutonomously(db, { autonomyLevel: 3 })).toBe(false);
    // select() should never have been called (short-circuit before DB query)
    expect((db.select as Mock).mock.calls.length).toBe(0);
  });

  it("(4) level=4 + flag=false → returns false", async () => {
    const db = makeDb({ [AUTONOMOUS_EMAIL_SETTING_KEY]: false });
    expect(await canRunAutonomously(db, { autonomyLevel: 4 })).toBe(false);
  });

  it("(5) level=4 + flag=true → returns true", async () => {
    const db = makeDb({ [AUTONOMOUS_EMAIL_SETTING_KEY]: true });
    expect(await canRunAutonomously(db, { autonomyLevel: 4 })).toBe(true);
  });

  it("(6) level=4 + flag='true' (string) → returns false (strict === true)", async () => {
    // Guards against a settings value written as the string "true" vs boolean true.
    const db = makeDb({ [AUTONOMOUS_EMAIL_SETTING_KEY]: "true" });
    expect(await canRunAutonomously(db, { autonomyLevel: 4 })).toBe(false);
  });

  it("(7) level=4 + no instance_settings row → returns false (safe default)", async () => {
    // Empty rows array — no settings row exists at all.
    const db = makeDb(undefined);
    expect(await canRunAutonomously(db, { autonomyLevel: 4 })).toBe(false);
  });
});

describe("describeAutonomyLevel", () => {
  it("(8) returns correct labels for all 4 levels + unknown", () => {
    expect(describeAutonomyLevel(1)).toBe("observe");
    expect(describeAutonomyLevel(2)).toBe("draft");
    expect(describeAutonomyLevel(3)).toBe("approval-required");
    expect(describeAutonomyLevel(4)).toBe("autonomous");
    expect(describeAutonomyLevel(99)).toMatch(/unknown/);
  });
});

describe("autonomyGateSummary", () => {
  it("(9) correct shape for level=2 (draft-only mode)", async () => {
    const db = makeDb({});
    const summary = await autonomyGateSummary(db, { id: "wf-1", autonomyLevel: 2 });

    expect(summary).toMatchObject({
      workflowId: "wf-1",
      autonomyLevel: 2,
      autonomyLabel: "draft",
      willRunAutonomously: false,
      requiresApprovalStep: false,
      isDraftOnlyMode: true,
    });
  });

  it("(10) correct shape for level=3 (approval-required)", async () => {
    const db = makeDb({});
    const summary = await autonomyGateSummary(db, { id: "wf-2", autonomyLevel: 3 });

    expect(summary).toMatchObject({
      autonomyLevel: 3,
      autonomyLabel: "approval-required",
      willRunAutonomously: false,
      requiresApprovalStep: true,
      isDraftOnlyMode: false,
    });
  });
});
