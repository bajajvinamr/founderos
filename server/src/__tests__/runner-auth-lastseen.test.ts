/**
 * L2-D22 — Runner-auth `lastSeenAt` invariant defense.
 *
 * Locks in the documented vinamr-invariant (CLAUDE.md):
 *
 *   "`runner_tokens.lastSeenAt` is what powers the pill liveness, not a
 *    heartbeat row. The runner-auth middleware updates `lastSeenAt = now()`
 *    on every authenticated request. \"Online\" = `lastSeenAt < 30s ago`.
 *    Don't add an explicit heartbeat endpoint; long-poll traffic IS the
 *    heartbeat."
 *
 * If a future refactor:
 *   (a) introduces an explicit heartbeat endpoint and stops touching
 *       `lastSeenAt` from the auth middleware, OR
 *   (b) reorders the middleware to update `lastSeenAt` BEFORE token
 *       validation (an "update first, validate second" anti-pattern that
 *       would let unauthenticated probes liveness-poison the dashboard),
 * one of these structural assertions fails at PR time.
 *
 * The complement (debounce semantics, TTL/rotation, ALS enrichment) is
 * covered by `runner-auth.test.ts`. This file is intentionally narrow:
 * **two** observable contracts.
 *
 *   1. Positive: a valid token's `lastSeenAt` lands within ~1s of the
 *      authenticated request — and within a freshness window vs the
 *      wall-clock NOW() at request time (NOT some pre-baked sentinel).
 *   2. Negative: an INVALID token (malformed + correct-format-wrong-hash)
 *      does NOT mutate any row's `lastSeenAt` — including the two tokens
 *      that DO exist in the test DB. Regression guard against
 *      update-then-validate ordering.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Request, type Response } from "express";
import { companies, createDb, runnerTokens } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __clearRunnerAuthDebounceCache,
  hashRunnerToken,
  runnerAuthMiddleware,
} from "../middleware/runner-auth.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping runner-auth-lastseen tests: ${support.reason ?? "unsupported environment"}`,
  );
}

// ─── Harness ───────────────────────────────────────────────────────────────

interface FakeResponseLog {
  status?: number;
  body?: unknown;
}

function makeFakeReqRes(authHeader: string | null) {
  const log: FakeResponseLog = {};
  const req = {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authHeader : undefined,
    requestId: "test-lastseen-req",
  } as unknown as Request;

  const res = {
    status(code: number) {
      log.status = code;
      return this;
    },
    json(body: unknown) {
      log.body = body;
      return this;
    },
  } as unknown as Response;

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  return { req, res, next, log, didNext: () => nextCalled };
}

/**
 * The middleware fires the lastSeenAt UPDATE fire-and-forget (no await), so
 * tests cannot synchronously observe the write. Poll for the row to flip
 * from `null` (or from `prev`) to a fresh value, with a generous deadline
 * for CI parallel load. Returns `{ value, latencyMs }` so the test can
 * report write latency without re-querying.
 */
async function waitForLastSeenAt(
  db: ReturnType<typeof createDb>,
  tokenId: string,
  prev: Date | null,
  deadlineMs = 5_000,
): Promise<{ value: Date; latencyMs: number }> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const [row] = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenId));
    if (row?.lastSeenAt && row.lastSeenAt.getTime() !== prev?.getTime()) {
      return { value: row.lastSeenAt, latencyMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `lastSeenAt did not update within ${deadlineMs}ms — middleware fire-and-forget UPDATE likely failed`,
  );
}

// ─── Suite ─────────────────────────────────────────────────────────────────

describeEmbeddedPostgres("runnerAuthMiddleware — lastSeenAt invariant (L2-D22)", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `LS${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  async function makeToken(companyId: string, plaintext: string) {
    const [row] = await db
      .insert(runnerTokens)
      .values({
        companyId,
        tokenHash: hashRunnerToken(plaintext),
        revokedAt: null,
        expiresAt: null,
      })
      .returning();
    return { plaintext, row };
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-runner-auth-lastseen-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  afterEach(() => {
    __clearRunnerAuthDebounceCache();
  });

  // ── Positive: lastSeenAt observably updates to ~NOW() on a valid request ──

  it("valid request: lastSeenAt is written within 1s and is within a freshness window of NOW()", async () => {
    const company = await makeCompany("LastSeen Pos Co");
    const { plaintext, row: tokenRow } = await makeToken(
      company.id,
      "fos_ls01aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    // Sanity: pre-request the row's lastSeenAt is NULL — no prior auth has
    // touched this token. If this is ever non-null, the harness leaked state
    // between tests and the freshness assertion below would be meaningless.
    const [preRow] = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenRow.id));
    expect(preRow.lastSeenAt).toBeNull();

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);

    // Capture wall-clock at request start so we can assert the WRITE lands
    // within a freshness window of NOW() — proves the middleware uses a
    // fresh `new Date()`, not a stale sentinel.
    const requestStartedAt = Date.now();
    await mw(req, res, next);

    expect(didNext()).toBe(true);

    const { value: observed, latencyMs } = await waitForLastSeenAt(
      db,
      tokenRow.id,
      null,
    );

    // Freshness: written value must be within a generous window of the
    // request's wall-clock time. 5s on each side handles slow CI parallel
    // load while still failing if the middleware writes a pre-baked or
    // stale timestamp.
    const skewMs = Math.abs(observed.getTime() - requestStartedAt);
    expect(skewMs).toBeLessThan(5_000);

    // The 1s SLO is what the invariant promises operators — "online means
    // lastSeenAt < 30s ago" only works if the write itself takes <1s.
    expect(latencyMs).toBeLessThan(1_000);
  });

  // ── Negative: invalid requests MUST NOT touch any row's lastSeenAt ──────

  it("invalid token (malformed) does NOT mutate any runner_tokens.lastSeenAt", async () => {
    const company = await makeCompany("LastSeen Neg Malformed Co");
    // Two real tokens in the DB — the regression we're guarding against is
    // an "update first, validate second" pattern. If such a refactor lands,
    // an UPDATE without a WHERE-on-id (or wrong WHERE) could touch the rows
    // we just inserted via a stray side-effect.
    const { row: tokenA } = await makeToken(
      company.id,
      "fos_ls02aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const { row: tokenB } = await makeToken(
      company.id,
      "fos_ls02bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    // Snapshot only the rows we control. The DB is shared across the file's
    // tests (Drizzle on a single embedded-pg cluster) so other tests' tokens
    // have non-null lastSeenAt — we deliberately do NOT assert on those.
    // The regression we're guarding is "an unauthenticated request mutated
    // OUR token's row," which is what the per-row assertion below catches.
    const beforeIds = [tokenA.id, tokenB.id];
    const beforeRows = await db
      .select({ id: runnerTokens.id, lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens);
    const beforeMine = beforeRows.filter((r) => beforeIds.includes(r.id));
    expect(beforeMine).toHaveLength(2);
    for (const row of beforeMine) {
      expect(row.lastSeenAt).toBeNull();
    }

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(
      "Bearer not_a_real_token",
    );
    await mw(req, res, next);

    // Hard contract: middleware must 401 and NOT call next().
    expect(log.status).toBe(401);
    expect(didNext()).toBe(false);

    // Give a fire-and-forget UPDATE (if one were incorrectly issued) time
    // to land before we assert it did not. 250ms is well above the
    // typical embedded-pg write latency (<50ms uncontended).
    await new Promise((r) => setTimeout(r, 250));

    const afterRows = await db
      .select({ id: runnerTokens.id, lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens);
    // Row-count invariant: an "update first, validate second" path could
    // also accidentally INSERT — guard against both shapes.
    expect(afterRows.length).toBe(beforeRows.length);

    const a = afterRows.find((r) => r.id === tokenA.id)!;
    const b = afterRows.find((r) => r.id === tokenB.id)!;
    expect(a.lastSeenAt).toBeNull();
    expect(b.lastSeenAt).toBeNull();
  });

  it("invalid token (correct format, wrong hash) does NOT mutate any lastSeenAt", async () => {
    const company = await makeCompany("LastSeen Neg Mismatch Co");
    // One real token in the DB — middleware-internal hash compare will fail.
    const { row: tokenA } = await makeToken(
      company.id,
      "fos_ls03aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const beforeRow = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenA.id));
    expect(beforeRow[0].lastSeenAt).toBeNull();

    const mw = runnerAuthMiddleware(db);
    // Correct format, never inserted — the WHERE clause filters on tokenHash,
    // so this 401s on the "no row" branch (defense-in-depth re-check is
    // exercised in runner-auth.test.ts).
    const { req, res, next, log, didNext } = makeFakeReqRes(
      "Bearer fos_ls03ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    );
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(didNext()).toBe(false);

    await new Promise((r) => setTimeout(r, 250));

    const afterRow = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, tokenA.id));
    expect(afterRow[0].lastSeenAt).toBeNull();
  });
});
