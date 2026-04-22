import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildDailyDigest,
  hourInTimezone,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  yesterdayWindow,
} from "../services/daily-digest.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping daily-digest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Pure helper tests — no DB required
// ---------------------------------------------------------------------------

describe("daily-digest pure helpers", () => {
  it("signUnsubscribeToken + verifyUnsubscribeToken round-trip", () => {
    const secret = "test-secret-please-rotate";
    const userId = "user_abc";
    const companyId = "00000000-0000-0000-0000-000000000001";
    const token = signUnsubscribeToken(userId, companyId, secret);
    expect(token).toContain(".");

    const verified = verifyUnsubscribeToken(token, secret);
    expect(verified).toEqual({ userId, companyId });
  });

  it("verifyUnsubscribeToken rejects a tampered signature", () => {
    const secret = "test-secret";
    const token = signUnsubscribeToken("u", "c", secret);
    const [payload, sig] = token.split(".");
    // Flip a byte in the signature — remains valid base64url-ish but won't verify.
    const flipped = sig!.startsWith("A") ? "B" + sig!.slice(1) : "A" + sig!.slice(1);
    const tampered = `${payload}.${flipped}`;
    expect(verifyUnsubscribeToken(tampered, secret)).toBeNull();
  });

  it("verifyUnsubscribeToken rejects a wrong secret", () => {
    const token = signUnsubscribeToken("u", "c", "secret-one");
    expect(verifyUnsubscribeToken(token, "secret-two")).toBeNull();
  });

  it("hourInTimezone returns 13 for 2026-04-21T12:30:00Z in Asia/Kolkata (UTC+5:30)", () => {
    const instant = new Date("2026-04-21T12:30:00Z");
    // IST = UTC+5:30 → 18:00 local
    expect(hourInTimezone(instant, "Asia/Kolkata")).toBe(18);
  });

  it("hourInTimezone returns the UTC hour for UTC", () => {
    const instant = new Date("2026-04-21T08:15:00Z");
    expect(hourInTimezone(instant, "UTC")).toBe(8);
  });

  it("yesterdayWindow produces a 24h UTC span covering the caller's prior local day", () => {
    // 2026-04-21 08:00 UTC == 2026-04-21 13:30 IST → yesterday IST == 2026-04-20
    const now = new Date("2026-04-21T08:00:00Z");
    const { start, end } = yesterdayWindow(now, "Asia/Kolkata");
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    // 2026-04-20 00:00 IST == 2026-04-19 18:30 UTC
    expect(start.toISOString()).toBe("2026-04-19T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-04-20T18:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("buildDailyDigest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("founderos-daily-digest-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Acme Labs",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexBot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("builds a digest for a user with a pending decision", async () => {
    const { companyId, agentId } = await seedCompany();
    const userId = "user_1";

    await db.insert(approvals).values({
      companyId,
      type: "ship_release",
      status: "pending",
      payload: { title: "Approve v0.7 release to prod" },
      requestedByAgentId: agentId,
    });

    const result = await buildDailyDigest(db, companyId, userId, {
      publicUrl: "https://app.test",
      now: new Date("2026-04-21T12:00:00Z"),
      timezone: "UTC",
    });

    expect(result).not.toBeNull();
    expect(result!.subject).toContain("1 decision");
    expect(result!.subject).toContain("Acme Labs");
    expect(result!.html).toContain("Approve v0.7 release to prod");
    expect(result!.html).toContain("Unsubscribe");
    expect(result!.text).toContain("Approve v0.7 release to prod");
    expect(result!.metrics.pendingDecisions).toBe(1);
  });

  it("returns null when there is no activity and no pending decisions", async () => {
    const { companyId } = await seedCompany();
    const result = await buildDailyDigest(db, companyId, "user_1", {
      publicUrl: "https://app.test",
      now: new Date("2026-04-21T12:00:00Z"),
      timezone: "UTC",
    });
    expect(result).toBeNull();
  });

  it("surfaces a failing agent from the last 24h", async () => {
    const { companyId, agentId } = await seedCompany();
    const now = new Date("2026-04-21T12:00:00Z");
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      startedAt: twoHoursAgo,
      finishedAt: twoHoursAgo,
      error: "Adapter RPC timed out after 60s",
    });

    const result = await buildDailyDigest(db, companyId, "user_1", {
      publicUrl: "https://app.test",
      now,
      timezone: "UTC",
    });

    expect(result).not.toBeNull();
    expect(result!.metrics.failingAgents).toBe(1);
    expect(result!.html).toContain("CodexBot");
    expect(result!.html).toContain("Adapter RPC timed out");
  });

  it("rolls up yesterday's agent cost from cost_events", async () => {
    const { companyId, agentId } = await seedCompany();
    const now = new Date("2026-04-21T12:00:00Z");
    // Yesterday in UTC: 2026-04-20, any time.
    const yesterdayNoon = new Date("2026-04-20T12:00:00Z");

    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
      model: "claude-sonnet",
      costCents: 123,
      occurredAt: yesterdayNoon,
    });

    const result = await buildDailyDigest(db, companyId, "user_1", {
      publicUrl: "https://app.test",
      now,
      timezone: "UTC",
    });

    expect(result).not.toBeNull();
    expect(result!.metrics.costYesterdayCents).toBe(123);
    expect(result!.html).toContain("$1.23");
  });
});
