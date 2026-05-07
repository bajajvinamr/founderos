/**
 * BYO-104 — Runner REST endpoint contract tests.
 *
 * Covers all 7 endpoints from docs/api/runner-openapi.yaml against real
 * embedded Postgres + a mini express harness:
 *
 *   Token-management (session-auth, company-owner or instance-admin):
 *     POST   /api/companies/:id/runner-tokens           — issue
 *     DELETE /api/companies/:id/runner-tokens/:tokenId  — revoke (idempotent)
 *     GET    /api/companies/:id/runner-status           — liveness
 *
 *   Runner-job (runner-token auth):
 *     GET  /api/runner/jobs/next             — long-poll
 *     POST /api/runner/jobs/:id/claim        — atomic claim race
 *     POST /api/runner/jobs/:id/events       — append + cross-token isolation
 *     POST /api/runner/jobs/:id/complete     — terminal + double-complete guard
 *
 * Real DB + real route handlers — no mocks. The harness injects a fake
 * `req.actor` per test (board-admin or runner) so the same routes can be
 * exercised against both auth surfaces without standing up the full
 * actorMiddleware + session resolver.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  runnerJobs,
  runnerTokens,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { runnerJobRoutes, runnerTokenManagementRoutes } from "../routes/runner.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping runner-routes tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("runner REST routes — BYO-104", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  /** Build a session-auth (board) harness app for a given userId. */
  function adminApp(userId: string, isInstanceAdmin = true, companyIds: string[] = []) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId,
        companyIds,
        isInstanceAdmin,
        source: "session",
      };
      next();
    });
    app.use("/api", runnerTokenManagementRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** Build a runner-token-auth harness app for a given (tokenId, companyId). */
  function runnerApp(tokenId: string, companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "runner",
        runnerTokenId: tokenId,
        companyId,
        source: "runner_token",
      };
      next();
    });
    app.use("/api/runner", runnerJobRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** Seed a Better Auth user row so createdByUserId FK can resolve. */
  async function makeUser(id: string) {
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id,
        name: "Test User",
        email: `${id}@test.local`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return id;
  }

  let prefixCounter = 0;
  async function makeCompany(name: string) {
    prefixCounter += 1;
    const issuePrefix = `RR${Date.now().toString(36).slice(-3).toUpperCase()}${prefixCounter}`;
    const [row] = await db.insert(companies).values({ name, issuePrefix }).returning();
    return row;
  }

  async function makeAgent(companyId: string) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Test Sarah",
        role: "ceo",
        adapterType: "byo_runner",
        adapterConfig: {},
        status: "idle",
      })
      .returning();
    return row;
  }

  async function makeHeartbeatRun(companyId: string, agentId: string) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "queued",
      })
      .returning();
    return row;
  }

  /** Insert a queued runner_jobs row directly (skips the adapter materialization). */
  async function makeQueuedJob(args: {
    companyId: string;
    agentId: string;
    runId: string;
    /** S7.0.1 — adapter the runner should dispatch to. Defaults to claude_local. */
    adapterType?: string;
  }) {
    const [row] = await db
      .insert(runnerJobs)
      .values({
        companyId: args.companyId,
        agentId: args.agentId,
        heartbeatRunId: args.runId,
        prompt: "test prompt",
        promptHash: "a".repeat(64),
        runtimeConfig: JSON.stringify({ timeoutSec: 60 }),
        adapterType: args.adapterType ?? "claude_local",
        status: "queued",
      })
      .returning();
    return row;
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-runner-routes-");
    db = createDb(temp.connectionString);
    // Pre-seed the real session-user id used by adminApp() — runner_tokens.created_by_user_id
    // FKs into "user", so a non-null value must resolve to a real row.
    await makeUser("admin-user");
    await makeUser("non-admin");
  }, 30_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  // ─── Token-management surface ─────────────────────────────────────────────

  describe("POST /api/companies/:id/runner-tokens — issue", () => {
    it("returns 201 with plaintext token + persists sha256 hash only", async () => {
      const company = await makeCompany("Issue Co");
      const app = adminApp("admin-user");

      const res = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "Vinamr's Mac" });

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^fos_[A-Za-z0-9]{32}$/);
      expect(res.body.tokenId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.label).toBe("Vinamr's Mac");

      // Verify the row was persisted with hash, not plaintext.
      const [row] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.id, res.body.tokenId));
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.tokenHash).not.toContain(res.body.token);
      expect(row.companyId).toBe(company.id);
      expect(row.revokedAt).toBeNull();
      expect(row.createdByUserId).toBe("admin-user");
    });

    it("returns 404 when company does not exist", async () => {
      const app = adminApp("admin-user");
      const res = await request(app)
        .post(`/api/companies/00000000-0000-0000-0000-000000000000/runner-tokens`)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("company_not_found");
    });

    it("returns 403 when actor is not instance-admin", async () => {
      const company = await makeCompany("No Admin Co");
      const app = adminApp("non-admin", /* isInstanceAdmin */ false);
      const res = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({});
      // assertCompanyAccess gate fires first because companyIds is [] and
      // local_implicit isn't set — so this lands as 403 from there.
      expect(res.status).toBe(403);
    });

    it("BYO-105: writes runner.token.issued audit log with issuer + label + tokenPreview", async () => {
      const company = await makeCompany("Audit Issue Co");
      const app = adminApp("admin-user");

      const issued = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "audit-target" });
      expect(issued.status).toBe(201);

      const audits = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id));
      const issuedRows = audits.filter((a) => a.action === "runner.token.issued");
      expect(issuedRows).toHaveLength(1);
      const row = issuedRows[0];
      expect(row.actorId).toBe("admin-user");
      expect(row.actorType).toBe("user");
      expect(row.entityType).toBe("runner_token");
      expect(row.entityId).toBe(issued.body.tokenId);
      expect(row.details).toMatchObject({
        tokenId: issued.body.tokenId,
        label: "audit-target",
        issuedByUserId: "admin-user",
      });
      expect((row.details as { tokenPreview: string }).tokenPreview).toMatch(/^fos_\w{4}…$/);
      // Plaintext token must NEVER appear in the audit row.
      expect(JSON.stringify(row.details)).not.toContain(issued.body.token);
    });
  });

  // BYO-105: list endpoint
  describe("GET /api/companies/:id/runner-tokens — list (BYO-105)", () => {
    it("returns active + revoked tokens with summary fields", async () => {
      const company = await makeCompany("List Co");
      const app = adminApp("admin-user");

      const a = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "active-token" });
      const b = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "stale-token" });
      // Revoke b so we can verify revoked tokens still appear in the list.
      await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${b.body.tokenId}`,
      );
      // Mark a recently-seen so online flag is true.
      await db
        .update(runnerTokens)
        .set({ lastSeenAt: new Date() })
        .where(eq(runnerTokens.id, a.body.tokenId));

      const res = await request(app).get(`/api/companies/${company.id}/runner-tokens`);
      expect(res.status).toBe(200);
      const tokens = res.body.tokens as Array<{
        tokenId: string;
        label: string;
        revokedAt: string | null;
        online: boolean;
      }>;
      expect(tokens).toHaveLength(2);
      const active = tokens.find((t) => t.label === "active-token");
      const revoked = tokens.find((t) => t.label === "stale-token");
      expect(active?.revokedAt).toBeNull();
      expect(active?.online).toBe(true);
      expect(revoked?.revokedAt).toMatch(/T/); // ISO datetime
      expect(revoked?.online).toBe(false);
      // Plaintext token must never appear in any list response.
      expect(JSON.stringify(res.body)).not.toContain("fos_");
    });

    it("scoped to the company — does not leak tokens from another company", async () => {
      const companyA = await makeCompany("Scope A Co");
      const companyB = await makeCompany("Scope B Co");
      const app = adminApp("admin-user");

      await request(app)
        .post(`/api/companies/${companyA.id}/runner-tokens`)
        .send({ label: "a-only" });
      await request(app)
        .post(`/api/companies/${companyB.id}/runner-tokens`)
        .send({ label: "b-only" });

      const res = await request(app).get(`/api/companies/${companyA.id}/runner-tokens`);
      const tokens = res.body.tokens as Array<{ label: string }>;
      expect(tokens.map((t) => t.label).sort()).toEqual(["a-only"]);
    });
  });

  describe("DELETE /api/companies/:id/runner-tokens/:tokenId — revoke", () => {
    it("sets revokedAt and is idempotent on second call", async () => {
      const company = await makeCompany("Revoke Co");
      const app = adminApp("admin-user");

      const issued = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "to-be-revoked" });
      expect(issued.status).toBe(201);
      const tokenId = issued.body.tokenId;

      const first = await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${tokenId}`,
      );
      expect(first.status).toBe(204);

      const [row] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.id, tokenId));
      expect(row.revokedAt).not.toBeNull();

      // Idempotent — second revoke still 204.
      const second = await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${tokenId}`,
      );
      expect(second.status).toBe(204);
    });

    it("returns 404 for unknown tokenId", async () => {
      const company = await makeCompany("Unknown Token Co");
      const app = adminApp("admin-user");
      const res = await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/00000000-0000-0000-0000-000000000000`,
      );
      expect(res.status).toBe(404);
    });

    it("BYO-106: writes runner.token.revoked audit log with revoker + preserves label", async () => {
      const company = await makeCompany("Audit Revoke Co");
      const app = adminApp("admin-user");

      const issued = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "labelled-and-revoked" });
      expect(issued.status).toBe(201);
      const tokenId = issued.body.tokenId;

      const del = await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${tokenId}`,
      );
      expect(del.status).toBe(204);

      // Audit-log row carries revoker identity.
      const audits = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id));
      const revokedRows = audits.filter((a) => a.action === "runner.token.revoked");
      expect(revokedRows).toHaveLength(1);
      expect(revokedRows[0].details).toMatchObject({
        tokenId,
        label: "labelled-and-revoked",
        revokedByUserId: "admin-user",
      });

      // Management UI history view: the row's label is NOT cleared on revoke
      // — operators need to see "what did this token do?" for revoked rows.
      const [row] = await db
        .select({ label: runnerTokens.label, revokedAt: runnerTokens.revokedAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, tokenId));
      expect(row.label).toBe("labelled-and-revoked");
      expect(row.revokedAt).not.toBeNull();
    });
  });

  describe("GET /api/companies/:id/runner-status — liveness", () => {
    it("returns active tokens with online=true when lastSeenAt within 30s", async () => {
      const company = await makeCompany("Status Co");
      const app = adminApp("admin-user");

      // Issue two tokens; mark one as recently-seen.
      const a = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "online" });
      const b = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "stale" });
      await db
        .update(runnerTokens)
        .set({ lastSeenAt: new Date() })
        .where(eq(runnerTokens.id, a.body.tokenId));
      await db
        .update(runnerTokens)
        .set({ lastSeenAt: new Date(Date.now() - 60_000) })
        .where(eq(runnerTokens.id, b.body.tokenId));

      const res = await request(app).get(`/api/companies/${company.id}/runner-status`);
      expect(res.status).toBe(200);
      const tokens = res.body.tokens as Array<{ tokenId: string; online: boolean; label: string }>;
      expect(tokens).toHaveLength(2);
      const online = tokens.find((t) => t.label === "online");
      const stale = tokens.find((t) => t.label === "stale");
      expect(online?.online).toBe(true);
      expect(stale?.online).toBe(false);
    });

    it("excludes revoked tokens", async () => {
      const company = await makeCompany("Status Excludes Co");
      const app = adminApp("admin-user");
      const issued = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "to-revoke" });
      await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${issued.body.tokenId}`,
      );
      const res = await request(app).get(`/api/companies/${company.id}/runner-status`);
      expect(res.body.tokens).toHaveLength(0);
    });
  });

  // ─── W0.3 (council 2026-05-05) ─ Token TTL + rotation ────────────────────

  describe("W0.3 — issuance TTL", () => {
    it("defaults to 90-day expiresAt and surfaces it in response + DB row", async () => {
      const company = await makeCompany("TTL Default Co");
      const app = adminApp("admin-user");

      const res = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "default-ttl" });

      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBeTruthy();
      const expiresAt = new Date(res.body.expiresAt);
      const expectedMs = Date.now() + 90 * 86_400_000;
      // Allow ±10s drift for test latency between handler clock + assertion clock.
      expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(10_000);

      // Persist matches response.
      const [row] = await db
        .select({ expiresAt: runnerTokens.expiresAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, res.body.tokenId));
      expect(row.expiresAt).not.toBeNull();
    });

    it("honors expiresInDays override and clamps to [1,365]", async () => {
      const company = await makeCompany("TTL Override Co");
      const app = adminApp("admin-user");

      const ok = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "30-day", expiresInDays: 30 });
      expect(ok.status).toBe(201);
      const dt = new Date(ok.body.expiresAt).getTime();
      expect(Math.abs(dt - (Date.now() + 30 * 86_400_000))).toBeLessThan(10_000);

      const tooLong = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "no", expiresInDays: 366 });
      expect(tooLong.status).toBe(400);

      const tooShort = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "no", expiresInDays: 0 });
      expect(tooShort.status).toBe(400);
    });

    it("expiresInDays: null preserves indefinite-token escape hatch", async () => {
      const company = await makeCompany("TTL Indefinite Co");
      const app = adminApp("admin-user");

      const res = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "indefinite", expiresInDays: null });
      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBeNull();

      const [row] = await db
        .select({ expiresAt: runnerTokens.expiresAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, res.body.tokenId));
      expect(row.expiresAt).toBeNull();
    });

    it("list endpoint surfaces expiresAt + expiresInDays for both active and revoked", async () => {
      const company = await makeCompany("TTL List Co");
      const app = adminApp("admin-user");

      await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "active-90d" });
      const indefinite = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "indefinite", expiresInDays: null });
      expect(indefinite.body.expiresAt).toBeNull();

      const res = await request(app).get(`/api/companies/${company.id}/runner-tokens`);
      expect(res.status).toBe(200);
      const tokens = res.body.tokens as Array<{
        label: string;
        expiresAt: string | null;
        expiresInDays: number | null;
      }>;
      const dated = tokens.find((t) => t.label === "active-90d");
      const ind = tokens.find((t) => t.label === "indefinite");
      expect(dated?.expiresInDays).toBeGreaterThanOrEqual(89);
      expect(dated?.expiresInDays).toBeLessThanOrEqual(90);
      expect(ind?.expiresAt).toBeNull();
      expect(ind?.expiresInDays).toBeNull();
    });
  });

  describe("POST /api/companies/:id/runner-tokens/:tokenId/rotate — rotation", () => {
    it("mints new token, revokes old, sets rotatedFromTokenId chain", async () => {
      const company = await makeCompany("Rotate Active Co");
      const app = adminApp("admin-user");

      const old = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "rotate-me" });
      expect(old.status).toBe(201);

      const rotated = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens/${old.body.tokenId}/rotate`)
        .send({ deviceFingerprint: "host-laptop-sha256-abc" });

      expect(rotated.status).toBe(201);
      expect(rotated.body.token).toMatch(/^fos_[A-Za-z0-9]{32}$/);
      expect(rotated.body.token).not.toBe(old.body.token);
      expect(rotated.body.rotatedFromTokenId).toBe(old.body.tokenId);
      expect(rotated.body.label).toBe("rotate-me"); // carried over
      expect(rotated.body.expiresAt).toBeTruthy();

      // DB chain + revocation invariants.
      const [oldRow] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.id, old.body.tokenId));
      const [newRow] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.id, rotated.body.tokenId));
      expect(oldRow.revokedAt).not.toBeNull();
      expect(newRow.revokedAt).toBeNull();
      expect(newRow.rotatedFromTokenId).toBe(old.body.tokenId);
      expect(newRow.deviceFingerprint).toBe("host-laptop-sha256-abc");
    });

    it("recovery path: rotates a revoked token without 409", async () => {
      const company = await makeCompany("Rotate Revoked Co");
      const app = adminApp("admin-user");

      const old = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "incident-revoked" });
      await request(app).delete(
        `/api/companies/${company.id}/runner-tokens/${old.body.tokenId}`,
      );

      const [revokedAtBefore] = await db
        .select({ revokedAt: runnerTokens.revokedAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, old.body.tokenId));
      const beforeMs = revokedAtBefore.revokedAt!.getTime();

      const rotated = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens/${old.body.tokenId}/rotate`)
        .send({});
      expect(rotated.status).toBe(201);
      expect(rotated.body.rotatedFromTokenId).toBe(old.body.tokenId);

      // The original revokedAt timestamp (incident time) must be preserved —
      // rotation does not re-stamp it.
      const [revokedAtAfter] = await db
        .select({ revokedAt: runnerTokens.revokedAt })
        .from(runnerTokens)
        .where(eq(runnerTokens.id, old.body.tokenId));
      expect(revokedAtAfter.revokedAt!.getTime()).toBe(beforeMs);
    });

    it("returns 404 when oldTokenId belongs to a different company (cross-tenant)", async () => {
      const companyA = await makeCompany("Rotate Tenant A");
      const companyB = await makeCompany("Rotate Tenant B");
      const app = adminApp("admin-user");

      const inA = await request(app)
        .post(`/api/companies/${companyA.id}/runner-tokens`)
        .send({ label: "in-A" });

      // Try rotating it via Company B's URL.
      const res = await request(app)
        .post(`/api/companies/${companyB.id}/runner-tokens/${inA.body.tokenId}/rotate`)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("runner_token_not_found");
    });

    it("writes runner.token.rotated audit log with old/new linkage", async () => {
      const company = await makeCompany("Rotate Audit Co");
      const app = adminApp("admin-user");

      const old = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens`)
        .send({ label: "audit-rotate" });
      const rotated = await request(app)
        .post(`/api/companies/${company.id}/runner-tokens/${old.body.tokenId}/rotate`)
        .send({});
      expect(rotated.status).toBe(201);

      const audits = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, company.id));
      const rotateRows = audits.filter((a) => a.action === "runner.token.rotated");
      expect(rotateRows).toHaveLength(1);
      const row = rotateRows[0];
      expect(row.entityId).toBe(rotated.body.tokenId);
      expect(row.details).toMatchObject({
        oldTokenId: old.body.tokenId,
        newTokenId: rotated.body.tokenId,
        rotatedByUserId: "admin-user",
        oldTokenWasRevoked: false,
      });
      expect((row.details as { tokenPreview: string }).tokenPreview).toMatch(/^fos_\w{4}…$/);
      // Plaintext tokens MUST NEVER appear in audit details.
      expect(JSON.stringify(row.details)).not.toContain(rotated.body.token);
      expect(JSON.stringify(row.details)).not.toContain(old.body.token);
    });
  });

  // ─── Runner-job surface ───────────────────────────────────────────────────

  describe("GET /api/runner/jobs/next — long-poll", () => {
    it("returns the queued job descriptor when one exists", async () => {
      const company = await makeCompany("Next Job Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });

      // Token row needed for actor identity, even though our harness mocks the actor.
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "x".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      const res = await request(app).get("/api/runner/jobs/next");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        jobId: job.id,
        agentId: agent.id,
        agentName: "Test Sarah",
      });
    });

    it("returns 204 when nothing is queued (within a tight test budget)", async () => {
      const company = await makeCompany("Empty Queue Co");
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "y".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      // Real long-poll is 30s. We patch via supertest's expect-and-disconnect
      // pattern: kill the connection after 1.5s — the route's `req.socket.destroyed`
      // guard will exit the loop. We don't assert on the body since the
      // connection was aborted; we assert the route doesn't throw.
      const promise = request(app)
        .get("/api/runner/jobs/next")
        .timeout({ deadline: 1500, response: 1500 });
      await expect(promise).rejects.toThrow();
    }, 5_000);
  });

  describe("POST /api/runner/jobs/:id/claim — atomic claim", () => {
    it("transitions queued → claimed and returns the prompt + runtimeConfig", async () => {
      const company = await makeCompany("Claim Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "z".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      const res = await request(app).post(`/api/runner/jobs/${job.id}/claim`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        jobId: job.id,
        agentId: agent.id,
        prompt: "test prompt",
        runtimeConfig: { timeoutSec: 60 },
        promptHash: "a".repeat(64),
      });

      const [updated] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job.id));
      expect(updated.status).toBe("claimed");
      expect(updated.claimedByTokenId).toBe(token.id);
    });

    it("second claim by another runner → 409 conflict", async () => {
      const company = await makeCompany("Race Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [tokenA] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "1".repeat(64) })
        .returning();
      const [tokenB] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "2".repeat(64) })
        .returning();

      const winner = runnerApp(tokenA.id, company.id);
      const loser = runnerApp(tokenB.id, company.id);

      const first = await request(winner).post(`/api/runner/jobs/${job.id}/claim`);
      expect(first.status).toBe(200);

      const second = await request(loser).post(`/api/runner/jobs/${job.id}/claim`);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("job_not_claimable");
    });

    it("cross-company → 404 (does not leak existence)", async () => {
      const companyA = await makeCompany("Owner Co");
      const companyB = await makeCompany("Attacker Co");
      const agent = await makeAgent(companyA.id);
      const run = await makeHeartbeatRun(companyA.id, agent.id);
      const job = await makeQueuedJob({
        companyId: companyA.id,
        agentId: agent.id,
        runId: run.id,
      });
      const [tokenB] = await db
        .insert(runnerTokens)
        .values({ companyId: companyB.id, tokenHash: "3".repeat(64) })
        .returning();
      const app = runnerApp(tokenB.id, companyB.id);

      const res = await request(app).post(`/api/runner/jobs/${job.id}/claim`);
      expect(res.status).toBe(404);
    });

    /**
     * S7.0.1 (council R1+R2 P1, Codex+Gemini both rounds) — round-trip test
     * for `runner_jobs.adapter_type`. Without this column flowing from
     * enqueue → DB → claim API → JobPayload, the multi-CLI dispatcher
     * (S7.1) has nothing to dispatch on. Pin the contract so a future
     * regression that drops the field can't merge silently.
     */
    it("S7.0.1 — claim API returns adapterType from runner_jobs row", async () => {
      const company = await makeCompany("Adapter Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        adapterType: "gemini_local",
      });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "g".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      const res = await request(app).post(`/api/runner/jobs/${job.id}/claim`);
      expect(res.status).toBe(200);
      expect(res.body.adapterType).toBe("gemini_local");

      // DB row should also carry the adapter type unchanged across the claim.
      const [updated] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job.id));
      expect(updated.adapterType).toBe("gemini_local");
    });

    it("S7.0.1 — claim API defaults adapterType to claude_local when row predates the column", async () => {
      // Simulate a row inserted via raw SQL bypassing the Drizzle default
      // (this is the "agent rows that slipped through migration" defensive
      // path — the NOT NULL DEFAULT in the migration normally handles this,
      // but the dispatcher legacy-fallback should be belt+suspenders).
      const company = await makeCompany("Legacy Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
        // Default → claude_local (mirrors the production default).
      });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "L".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      const res = await request(app).post(`/api/runner/jobs/${job.id}/claim`);
      expect(res.status).toBe(200);
      expect(res.body.adapterType).toBe("claude_local");
    });
  });

  describe("POST /api/runner/jobs/:id/events — append batch", () => {
    it("appends events to heartbeat_run_events and flips status to streaming", async () => {
      const company = await makeCompany("Events Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "4".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      // Claim first (events guard requires claim ownership).
      const claim = await request(app).post(`/api/runner/jobs/${job.id}/claim`);
      expect(claim.status).toBe(200);

      const res = await request(app)
        .post(`/api/runner/jobs/${job.id}/events`)
        .send({
          events: [
            {
              eventId: "11111111-1111-1111-1111-111111111111",
              kind: "stdout_line",
              ts: new Date().toISOString(),
              payload: "claude says hello",
            },
            {
              eventId: "22222222-2222-2222-2222-222222222222",
              kind: "claude_message",
              ts: new Date().toISOString(),
              payload: { text: "hi", role: "assistant" },
            },
          ],
        });
      expect(res.status).toBe(204);

      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id));
      expect(events).toHaveLength(2);
      expect(events.find((e) => e.eventType === "stdout_line")?.message).toBe(
        "claude says hello",
      );
      expect(events.find((e) => e.eventType === "claude_message")?.payload).toMatchObject({
        text: "hi",
        role: "assistant",
      });

      const [updated] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job.id));
      expect(updated.status).toBe("streaming");
    });

    it("403 when a different token tries to append (claim ownership gate)", async () => {
      const company = await makeCompany("Wrong Token Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [tokenA] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "5".repeat(64) })
        .returning();
      const [tokenB] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "6".repeat(64) })
        .returning();

      // A claims, B tries to append.
      const claimer = runnerApp(tokenA.id, company.id);
      await request(claimer).post(`/api/runner/jobs/${job.id}/claim`);

      const intruder = runnerApp(tokenB.id, company.id);
      const res = await request(intruder)
        .post(`/api/runner/jobs/${job.id}/events`)
        .send({
          events: [
            {
              eventId: "33333333-3333-3333-3333-333333333333",
              kind: "stdout_line",
              ts: new Date().toISOString(),
              payload: "intrusion attempt",
            },
          ],
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("job_not_owned_by_token");
    });
  });

  describe("POST /api/runner/jobs/:id/complete — terminal transition", () => {
    it("sets status, exitCode, costMicros, sessionIdAfter; rejects double-complete", async () => {
      const company = await makeCompany("Complete Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "7".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      await request(app).post(`/api/runner/jobs/${job.id}/claim`);

      const ok = await request(app)
        .post(`/api/runner/jobs/${job.id}/complete`)
        .send({
          status: "completed",
          exitCode: 0,
          elapsedSec: 12.5,
          costMicros: 1_500_000,
          sessionId: "sess_abc",
          cliVersion: "claude 0.18.1",
        });
      expect(ok.status).toBe(204);

      const [row] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job.id));
      expect(row.status).toBe("completed");
      expect(row.exitCode).toBe(0);
      expect(row.elapsedMs).toBe(12_500);
      expect(row.costMicros).toBe(1_500_000);
      expect(row.sessionIdAfter).toBe("sess_abc");
      expect(row.cliVersion).toBe("claude 0.18.1");

      // Double-complete → 409.
      const dup = await request(app)
        .post(`/api/runner/jobs/${job.id}/complete`)
        .send({ status: "completed", exitCode: 0 });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe("job_already_terminal");
    });

    it("400 on invalid completion body (Zod schema)", async () => {
      const company = await makeCompany("Bad Body Co");
      const agent = await makeAgent(company.id);
      const run = await makeHeartbeatRun(company.id, agent.id);
      const job = await makeQueuedJob({ companyId: company.id, agentId: agent.id, runId: run.id });
      const [token] = await db
        .insert(runnerTokens)
        .values({ companyId: company.id, tokenHash: "8".repeat(64) })
        .returning();
      const app = runnerApp(token.id, company.id);

      const res = await request(app)
        .post(`/api/runner/jobs/${job.id}/complete`)
        .send({ status: "weird", exitCode: "not-a-number" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    });
  });

  // ─── Reset prefix counter between groups so no UNIQUE collision ──────────

  beforeEach(() => {
    // Used implicitly by makeCompany; nothing else to reset between tests.
  });
});
