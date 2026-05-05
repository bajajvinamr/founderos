/**
 * BYO-101 — Runner-token auth middleware tests.
 *
 * Verifies threat-model T1 + T2 mitigations against real embedded Postgres:
 *   - Valid token → req.actor populated, lastSeenAt updated.
 *   - Malformed token → 401 (no DB hit; same shape as mismatch).
 *   - Mismatch (wrong hash) → 401 (constant-time compare path).
 *   - Revoked token → 401 (revoked_at IS NOT NULL filter).
 *   - lastSeenAt debounce — repeated polls don't write 12 rows per minute.
 *   - Cross-company isolation — token for Company A cannot resolve as Company B.
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
  console.warn(`Skipping runner-auth tests: ${support.reason ?? "unsupported environment"}`);
}

// ─── Test harness ──────────────────────────────────────────────────────────

interface FakeResponseLog {
  status?: number;
  body?: unknown;
}

function makeFakeReqRes(authHeader: string | null) {
  const log: FakeResponseLog = {};
  const req = {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : undefined),
    requestId: "test-req-id",
  } as unknown as Request;

  // Capture status + json shape; ignore the chaining sugar tests don't need.
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

// ─── Suite ─────────────────────────────────────────────────────────────────

describeEmbeddedPostgres("runnerAuthMiddleware — BYO-101", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `RA${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  /** Insert a token and return both the plaintext and the row. */
  async function makeToken(
    companyId: string,
    plaintext: string,
    opts?: {
      revoked?: boolean;
      /** W0.3: explicit expiry timestamp (Date in past = expired now). */
      expiresAt?: Date | null;
    },
  ) {
    const [row] = await db
      .insert(runnerTokens)
      .values({
        companyId,
        tokenHash: hashRunnerToken(plaintext),
        revokedAt: opts?.revoked ? new Date() : null,
        expiresAt: opts?.expiresAt ?? null,
      })
      .returning();
    return { plaintext, row };
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-runner-auth-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  afterEach(() => {
    __clearRunnerAuthDebounceCache();
  });

  it("valid token → req.actor populated with companyId + tokenId", async () => {
    const company = await makeCompany("Valid Co");
    const { plaintext, row: tokenRow } = await makeToken(
      company.id,
      "fos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(log.status).toBeUndefined();
    expect(didNext()).toBe(true);
    expect(req.actor).toMatchObject({
      type: "runner",
      companyId: company.id,
      runnerTokenId: tokenRow.id,
      source: "runner_token",
    });
  });

  it("malformed token → 401 invalid_runner_token", async () => {
    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes("Bearer not_a_real_token");
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(log.body).toMatchObject({ error: "invalid_runner_token", requestId: "test-req-id" });
    expect(didNext()).toBe(false);
  });

  it("missing Authorization header → 401", async () => {
    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(null);
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(didNext()).toBe(false);
  });

  it("hash-mismatch token (correct format, wrong value) → 401", async () => {
    const company = await makeCompany("Mismatch Co");
    await makeToken(company.id, "fos_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(
      "Bearer fos_cccccccccccccccccccccccccccccccc",
    );
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(log.body).toMatchObject({ error: "invalid_runner_token" });
    expect(didNext()).toBe(false);
  });

  it("revoked token → 401 (revoked_at filter)", async () => {
    const company = await makeCompany("Revoked Co");
    const { plaintext } = await makeToken(
      company.id,
      "fos_dddddddddddddddddddddddddddddddd",
      { revoked: true },
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(didNext()).toBe(false);
  });

  it("lastSeenAt updated on first auth, debounced on rapid second", async () => {
    const company = await makeCompany("Debounce Co");
    const { plaintext, row: token } = await makeToken(
      company.id,
      "fos_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );

    const mw = runnerAuthMiddleware(db);

    // First poll — lastSeenAt should be set.
    {
      const { req, res, next } = makeFakeReqRes(`Bearer ${plaintext}`);
      await mw(req, res, next);
    }

    // Give the fire-and-forget update a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const [afterFirst] = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, token.id));
    expect(afterFirst.lastSeenAt).not.toBeNull();
    const firstSeenAt = afterFirst.lastSeenAt!;

    // Second poll within the 30s debounce window — should NOT write again.
    {
      const { req, res, next } = makeFakeReqRes(`Bearer ${plaintext}`);
      await mw(req, res, next);
    }
    await new Promise((r) => setTimeout(r, 50));

    const [afterSecond] = await db
      .select({ lastSeenAt: runnerTokens.lastSeenAt })
      .from(runnerTokens)
      .where(eq(runnerTokens.id, token.id));
    expect(afterSecond.lastSeenAt!.getTime()).toBe(firstSeenAt.getTime());
  });

  it("BYO-109: ALS actor.runnerTokenId is populated for downstream Sentry/log enrichment", async () => {
    // The pino mixin + Sentry scope auto-pull from getRequestContext().actor.
    // For runner-originated incidents we need the tokenId in that context so
    // log/Sentry tagging can correlate the failing request to the issuing token.
    const company = await makeCompany("ALS Tag Co");
    const { plaintext, row: tokenRow } = await makeToken(
      company.id,
      "fos_gggggggggggggggggggggggggggggggg",
    );

    const { runWithRequestContext, getRequestContext } = await import(
      "../lib/request-context.js"
    );

    const mw = runnerAuthMiddleware(db);
    let observedActor: { runnerTokenId?: string; companyId?: string; type?: string } | undefined;
    await runWithRequestContext(
      { requestId: "test-als-req", traceId: "test-als-trace" },
      async () => {
        const { req, res, next } = makeFakeReqRes(`Bearer ${plaintext}`);
        const wrappedNext = () => {
          observedActor = getRequestContext()?.actor;
          next();
        };
        await mw(req, res, wrappedNext);
      },
    );

    expect(observedActor).toBeDefined();
    expect(observedActor?.type).toBe("runner");
    expect(observedActor?.companyId).toBe(company.id);
    expect(observedActor?.runnerTokenId).toBe(tokenRow.id);
  });

  it("cross-company isolation — Company A's token does not resolve to Company B", async () => {
    // T2/M2.1 — bind: token resolves to ONE companyId. Even if a downstream
    // route queries with the wrong companyId, it should pull req.actor.companyId
    // (which is set here from the token row) and not the URL parameter.
    const companyA = await makeCompany("Company A");
    const companyB = await makeCompany("Company B");
    const { plaintext, row: tokenRow } = await makeToken(
      companyA.id,
      "fos_ffffffffffffffffffffffffffffffff",
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(req.actor.companyId).toBe(companyA.id);
    expect(req.actor.companyId).not.toBe(companyB.id);
    expect(req.actor.runnerTokenId).toBe(tokenRow.id);
  });

  // ── W0.3 (council 2026-05-05) — TTL + rotation ──────────────────────────────

  it("W0.3 — token with future expires_at → 200 next() (active TTL)", async () => {
    const company = await makeCompany("Future Expiry Co");
    // 90 days from now — the default TTL we'll set on issuance.
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const { plaintext, row: tokenRow } = await makeToken(
      company.id,
      // 32 alphanumeric chars after `fos_` (TOKEN_FORMAT regex).
      "fos_w0301aaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { expiresAt: future },
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(log.status).toBeUndefined();
    expect(didNext()).toBe(true);
    expect(req.actor.runnerTokenId).toBe(tokenRow.id);
  });

  it("W0.3 — token with past expires_at → 401 runner_token_expired + rotationHint", async () => {
    const company = await makeCompany("Expired Co");
    // 1 hour ago — a representative expired token.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { plaintext } = await makeToken(
      company.id,
      "fos_w0302bbbbbbbbbbbbbbbbbbbbbbbbbbb",
      { expiresAt: past },
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(log.status).toBe(401);
    expect(log.body).toMatchObject({
      error: "runner_token_expired",
      code: "expired",
    });
    // Critical: rotationHint must be present so the runner CLI can prompt
    // cleanly instead of looping on a 401 forever.
    expect(log.body.rotationHint).toBeTruthy();
    expect(typeof log.body.expiredAt).toBe("string");
    expect(didNext()).toBe(false);
  });

  it("W0.3 — token with NULL expires_at (legacy) → 200 next() (backward compat)", async () => {
    // Pre-migration-0089 tokens have no expires_at. Auth middleware must
    // still accept them — operators can manually rotate via the dashboard.
    const company = await makeCompany("Legacy TokenCo");
    const { plaintext, row: tokenRow } = await makeToken(
      company.id,
      "fos_w0303ccccccccccccccccccccccccccc",
      { expiresAt: null },
    );

    const mw = runnerAuthMiddleware(db);
    const { req, res, next, log, didNext } = makeFakeReqRes(`Bearer ${plaintext}`);
    await mw(req, res, next);

    expect(log.status).toBeUndefined();
    expect(didNext()).toBe(true);
    expect(req.actor.runnerTokenId).toBe(tokenRow.id);
  });
});
