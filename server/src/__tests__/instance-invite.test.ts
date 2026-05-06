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
  // PR-4 (2026-05-07): consumeInvite now wraps consume + role grant in
  // db.transaction(...). Tests can simulate the role-INSERT failing by
  // setting `insertThrows`. Default null = insert succeeds. The stub's
  // `transaction(fn)` simply calls back with the same db (acts as `tx`),
  // mirroring drizzle's behavior at the API surface; rollback is enforced
  // by re-throwing the error from the callback so the production code
  // path observes the same control flow as a real PG transaction abort.
  insertThrows?: Error | null;
} = {}) {
  const { updateRows = [], insertRows = [], insertThrows = null } = opts;
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

  // insert().values() must be awaitable (for the raw grant path), support
  // .returning() (for createInvite), and support .onConflictDoNothing()
  // (PR-4: idempotent role-grant on unique-violation). We return an object
  // that is a thenable AND has a returning() / onConflictDoNothing() method.
  // If `insertThrows` is set, the awaitable rejects (simulates a non-unique
  // failure like FK violation that should propagate, not be swallowed).
  const insertSettled = insertThrows
    ? Promise.reject(insertThrows)
    : Promise.resolve(undefined);
  // Swallow the rejection at construction time so vitest doesn't log
  // "unhandled rejection" — production code will await this and observe
  // the throw via the await, which is what we want to verify.
  insertSettled.catch(() => {});
  // `await thenable` calls `thenable.then(resolve, reject)`. The mock MUST
  // accept BOTH callbacks and pass them through, otherwise rejections are
  // silently swallowed by the await — the test asserting `.rejects` would
  // hang until the 30s timeout. Same for `.catch`.
  const insertValuesResolvedValue: Record<string, unknown> = {
    returning: vi.fn().mockResolvedValue(insertRows),
    onConflictDoNothing: vi.fn().mockReturnValue({
      then: (onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) =>
        insertSettled.then(onfulfilled, onrejected),
      catch: (onrejected: (e: unknown) => unknown) => insertSettled.catch(onrejected),
    }),
    then: (onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) =>
      insertSettled.then(onfulfilled, onrejected),
    catch: (onrejected: (e: unknown) => unknown) => insertSettled.catch(onrejected),
  };
  const insertValuesMock = vi.fn().mockReturnValue(insertValuesResolvedValue);
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  // db.transaction(fn) — drizzle's transaction surface gives the callback
  // a `tx` object with the same query API. Our stub passes through to the
  // same select/update/insert/delete mocks (so call counts include both
  // tx-scoped and non-tx-scoped invocations from the function under test).
  // Errors thrown inside fn propagate out — that's what real PG rollback
  // looks like at the JS layer.
  const transactionMock = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    return await fn(dbObj);
  });

  const dbObj: Record<string, unknown> = {
    select: selectMock,
    update: updateMock,
    insert: insertMock,
    delete: deleteMock,
    transaction: transactionMock,
  };

  return {
    db: dbObj as unknown,
    selectMock,
    updateReturningMock,
    insertValuesMock,
    deleteWhereMock,
    transactionMock,
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

// ---------------------------------------------------------------------------
// consumeInvite — atomic consume + role grant (PR-4, council 2026-05-07 P1)
// ---------------------------------------------------------------------------
//
// Pre-PR-4 behavior: invite UPDATE and role INSERT were sequential. If the
// role insert threw a non-unique error (e.g., FK violation when the
// public."user" mirror is missing — the exact failure mode the 2026-05-04
// council surfaced), the catch at the old line 185 logged "non-fatal" and
// returned the consumed invite. Result: invite marked consumed, role NOT
// granted — user permanently locked out (cannot re-claim, cannot retry).
//
// Post-PR-4 behavior: both ops run inside `db.transaction(...)`. A throwing
// role insert rolls the consume back at the PG layer, the invite stays
// pending, and the caller (post-signup-hook.ts) catches and treats it as
// non-fatal — but on the user's next auth attempt, the invite is still
// claimable.
//
// We also assert that a unique-violation on (user_id, role) is treated as
// success (idempotent re-grant) via `.onConflictDoNothing()`. That's the
// case the original code's swallow was tolerating; the fix preserves that
// case without swallowing other errors.

describe("instanceInviteService.consumeInvite — atomic consume + role grant", () => {
  it("rolls back the consume when role insert throws a non-unique error (FK violation)", async () => {
    const pending = makeInvite();
    const consumed = {
      ...pending,
      consumedAt: new Date(),
      consumedBy: "user-fk-fail",
    };

    // FK violation: the public."user" mirror upsert hasn't run yet, so the
    // FK on instance_user_roles.user_id rejects. Postgres error code 23503.
    const fkError = Object.assign(new Error("foreign key violation"), {
      code: "23503",
    });

    const { db, transactionMock, updateReturningMock, insertValuesMock } = makeDb({
      selectSequence: [[pending], []], // pending invite, no existing role
      updateRows: [consumed],
      insertThrows: fkError,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);

    // The fix MUST propagate the error, not swallow + return consumed.
    // Caller (post-signup-hook) is already wrapped in try/catch → logs +
    // proceeds. The invite remains claimable on the user's next attempt.
    await expect(
      svc.consumeInvite({ email: "fk-fail@example.com", userId: "user-fk-fail" }),
    ).rejects.toMatchObject({ code: "23503" });

    // The transaction must have been opened (proves we're using db.transaction).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // The UPDATE must have been issued (proves consume was attempted).
    expect(updateReturningMock).toHaveBeenCalled();
    // The INSERT must have been issued (proves we tried to grant — and threw).
    expect(insertValuesMock).toHaveBeenCalled();
  });

  it("treats unique-violation on (user_id, role) as idempotent success (onConflictDoNothing)", async () => {
    // The role row already exists from a prior partial attempt or replay.
    // The fix uses .onConflictDoNothing({ target: [userId, role] }) so the
    // transaction commits cleanly with the consume marked. This preserves
    // the "duplicate grants are harmless" semantics from the original
    // try/catch swallow without swallowing real errors.
    const pending = makeInvite();
    const consumed = {
      ...pending,
      consumedAt: new Date(),
      consumedBy: "user-reattempt",
    };

    const { db, transactionMock, insertValuesMock } = makeDb({
      // Empty existing-role lookup → fix attempts INSERT; PG would normally
      // raise 23505 but onConflictDoNothing turns it into a no-op.
      selectSequence: [[pending], []],
      updateRows: [consumed],
      // insertThrows null → onConflictDoNothing path resolves cleanly.
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({
      email: "reattempt@example.com",
      userId: "user-reattempt",
    });

    expect(result).not.toBeNull();
    expect(result?.consumedBy).toBe("user-reattempt");
    expect(transactionMock).toHaveBeenCalledTimes(1);
    // The fix MUST call .onConflictDoNothing — verify it via the mock
    // chain. We pull onConflictDoNothing off the mocked .values() result.
    const valuesCall = insertValuesMock.mock.results[0]?.value as
      | { onConflictDoNothing?: { mock: { calls: unknown[][] } } }
      | undefined;
    expect(valuesCall?.onConflictDoNothing?.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns null without granting when update race is lost — no transaction needed for grant", async () => {
    // Sanity check: when the UPDATE returns no rows (race), the function
    // exits inside the transaction with `return null` BEFORE attempting
    // the role insert. The transaction wrapper still opened, but commits
    // empty — no rollback, no thrown error, no role grant.
    const pending = makeInvite();
    const { db, transactionMock, updateReturningMock, insertValuesMock } = makeDb({
      selectSequence: [[pending]],
      updateRows: [], // race lost
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = instanceInviteService(db as any);
    const result = await svc.consumeInvite({ email: "race@x.com", userId: "u" });

    expect(result).toBeNull();
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateReturningMock).toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});
