/**
 * Tests for instanceInviteService.
 *
 * Uses a lightweight DB stub (no embedded Postgres) so the tests exercise
 * the service's control flow directly:
 *
 *  - happy path: pending invite for the email → marked consumed + role
 *                row inserted
 *  - no-op: already consumed → nothing to do, returns null
 *  - no-op: expired invite → not selected, returns null
 *  - no-op: no invite for this email → returns null
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { instanceInviteService } from "../services/instance-invite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InviteRow = {
  id: string;
  email: string;
  role: string;
  token: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
};

function makeInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "invite-1",
    email: "new@example.com",
    role: "instance_member",
    token: "tok-abc",
    createdBy: "admin-1",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    consumedAt: null,
    consumedBy: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

/**
 * Build a DB stub covering the access patterns in instanceInviteService:
 *  - select().from().where().orderBy().limit()  → selectSequence[n]
 *  - select().from().where() [then-awaited]     → selectSequence[n]
 *  - update().set().where().returning()         → updateRows
 *  - insert().values() [awaited]                → resolves
 *  - insert().values().returning()              → insertRows
 *  - delete().where() [awaited]                 → resolves
 *
 * selectSequence controls successive select() calls in order.
 */
function makeDb(opts: {
  selectSequence?: unknown[][];
  updateRows?: unknown[];
  insertRows?: unknown[];
} = {}) {
  const { updateRows = [], insertRows = [] } = opts;
  const selectSequence = opts.selectSequence ?? [[]];
  let selectCallIndex = 0;

  function buildSelectChain(rows: unknown[]) {
    const limitMock = vi.fn().mockResolvedValue(rows);
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const whereResult: Record<string, unknown> = {
      orderBy: orderByMock,
      limit: limitMock,
      then: (onfulfilled: (v: unknown[]) => unknown) => Promise.resolve(rows).then(onfulfilled),
      catch: (onrejected: (e: unknown) => unknown) => Promise.resolve(rows).catch(onrejected),
    };
    const fromMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
      // Some selects (listMembers) use leftJoin — not exercised here but
      // kept for future tests.
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    });
    return { fromMock };
  }

  const selectMock = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    const rows = selectSequence[idx] ?? selectSequence[selectSequence.length - 1] ?? [];
    const { fromMock } = buildSelectChain(rows);
    return { from: fromMock };
  });

  const updateReturningMock = vi.fn().mockResolvedValue(updateRows);
  const updateWhereMock = vi.fn().mockReturnValue({ returning: updateReturningMock });
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  // insert().values() must be awaitable (for the raw grant path) and also
  // support .returning() (for createInvite). We return an object that is a
  // thenable AND has a returning() method.
  const insertValuesResolvedValue: Record<string, unknown> = {
    returning: vi.fn().mockResolvedValue(insertRows),
    then: (onfulfilled: (v: unknown) => unknown) => Promise.resolve(undefined).then(onfulfilled),
    catch: (onrejected: (e: unknown) => unknown) => Promise.resolve(undefined).catch(onrejected),
  };
  const insertValuesMock = vi.fn().mockReturnValue(insertValuesResolvedValue);
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  return {
    db: {
      select: selectMock,
      update: updateMock,
      insert: insertMock,
      delete: deleteMock,
    } as unknown,
    selectMock,
    updateReturningMock,
    insertValuesMock,
    deleteWhereMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// consumeInvite — happy path
// ---------------------------------------------------------------------------

describe("instanceInviteService.consumeInvite — happy path", () => {
  it("marks pending invite consumed and grants the instance role", async () => {
    const pending = makeInvite();
    const consumed = {
      ...pending,
      consumedAt: new Date(),
      consumedBy: "user-42",
    };

    // selectSequence:
    // [0] pending invite lookup → [pending]
    // [1] existing role check   → []     (no duplicate)
    const { db, updateReturningMock, insertValuesMock } = makeDb({
      selectSequence: [[pending], []],
      updateRows: [consumed],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "NEW@example.com", // tests lowercasing
      userId: "user-42",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("invite-1");
    expect(result?.consumedBy).toBe("user-42");
    expect(updateReturningMock).toHaveBeenCalled();
    // Insert into instance_user_roles should have been invoked once.
    expect(insertValuesMock).toHaveBeenCalledWith({
      userId: "user-42",
      role: "instance_member",
    });
  });
});

// ---------------------------------------------------------------------------
// consumeInvite — no-op cases
// ---------------------------------------------------------------------------

describe("instanceInviteService.consumeInvite — no-op cases", () => {
  it("returns null when no pending invite exists for the email", async () => {
    // Pending invite lookup returns empty → nothing to do.
    const { db, updateReturningMock, insertValuesMock } = makeDb({
      selectSequence: [[]],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "unknown@example.com",
      userId: "user-1",
    });

    expect(result).toBeNull();
    expect(updateReturningMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("returns null when the invite lookup excludes already-consumed rows", async () => {
    // Service filters by isNull(consumedAt), so an already-consumed invite
    // never surfaces in the select. Stub returns empty to simulate that.
    const { db, updateReturningMock } = makeDb({
      selectSequence: [[]],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "already@example.com",
      userId: "user-2",
    });

    expect(result).toBeNull();
    expect(updateReturningMock).not.toHaveBeenCalled();
  });

  it("returns null when only expired invites exist (filtered by expires_at > now)", async () => {
    // Service filters gt(expiresAt, now). An expired invite therefore
    // never appears in the select result — stub returns empty.
    const { db, updateReturningMock } = makeDb({
      selectSequence: [[]],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "expired@example.com",
      userId: "user-3",
    });

    expect(result).toBeNull();
    expect(updateReturningMock).not.toHaveBeenCalled();
  });

  it("treats empty email as a no-op without hitting the DB", async () => {
    const { db, selectMock } = makeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({ email: "   ", userId: "user-1" });
    expect(result).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// consumeInvite — race / concurrent consume
// ---------------------------------------------------------------------------

describe("instanceInviteService.consumeInvite — race with concurrent consume", () => {
  it("returns null when another consume won the update race", async () => {
    const pending = makeInvite();

    // The update().returning() resolves to [] when the WHERE clause
    // (id matches AND consumed_at IS NULL) doesn't match — meaning a
    // concurrent consume already flipped it.
    const { db, updateReturningMock, insertValuesMock } = makeDb({
      selectSequence: [[pending]],
      updateRows: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "racer@example.com",
      userId: "user-9",
    });

    expect(result).toBeNull();
    expect(updateReturningMock).toHaveBeenCalled();
    // Role grant must NOT happen when update returned no rows.
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});
