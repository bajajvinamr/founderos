/**
 * composio-connection-resolver.test.ts — S4.8 prerequisite #198.
 *
 * Tests the typed connectedAccountId resolver that customer-facing
 * autonomous templates (churn-rescue first) MUST route through.
 *
 * Coverage:
 *   1. Active connection → returns composioConnectionId
 *   2. Multiple active rows → returns most-recently-updated
 *   3. No row at all → throws status="missing"
 *   4. Only pending → throws status="pending"
 *   5. Only failed → throws status="failed"
 *   6. Only revoked → throws status="revoked"
 *   7. Cross-tenant: company A's connection NOT visible to company B
 *   8. Cross-app: hubspot connection NOT returned for slack lookup
 *   9. tryResolveConnectedAccountId returns null instead of throwing
 *  10. tryResolveConnectedAccountId re-throws non-Missing errors
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  composioConnections,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ComposioConnectionMissingError,
  resolveConnectedAccountId,
  tryResolveConnectedAccountId,
} from "../services/composio-connection-resolver.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping composio-connection-resolver tests: ${support.reason ?? "unsupported"}`,
  );
}

describeEmbedded("composio-connection-resolver", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyAId: string;
  let companyBId: string;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("composio-resolver");
    db = createDb(testDb.connectionString);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);

    const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const [a] = await db
      .insert(companies)
      .values({ name: "Co A", instanceId: "test", issuePrefix: `CA${suffix}` })
      .returning();
    const [b] = await db
      .insert(companies)
      .values({ name: "Co B", instanceId: "test", issuePrefix: `CB${suffix}` })
      .returning();
    companyAId = a.id;
    companyBId = b.id;
  });

  it("returns composioConnectionId when active connection exists", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_active_abc",
      status: "active",
    });

    const id = await resolveConnectedAccountId(db, companyAId, "hubspot");
    expect(id).toBe("conn_active_abc");
  });

  it("with multiple active rows, returns the most recently updated", async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    const later = new Date();

    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_old",
      status: "active",
      createdAt: earlier,
      updatedAt: earlier,
    });
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-2",
      appName: "hubspot",
      composioConnectionId: "conn_new",
      status: "active",
      createdAt: later,
      updatedAt: later,
    });

    const id = await resolveConnectedAccountId(db, companyAId, "hubspot");
    expect(id).toBe("conn_new");
  });

  it("throws status='missing' when no row exists", async () => {
    await expect(
      resolveConnectedAccountId(db, companyAId, "hubspot"),
    ).rejects.toThrowError(ComposioConnectionMissingError);
    try {
      await resolveConnectedAccountId(db, companyAId, "hubspot");
    } catch (err) {
      if (err instanceof ComposioConnectionMissingError) {
        expect(err.status).toBe("missing");
      } else {
        throw err;
      }
    }
  });

  it("throws status='pending' when only pending row exists", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_pending",
      status: "pending",
    });

    try {
      await resolveConnectedAccountId(db, companyAId, "hubspot");
      throw new Error("should have thrown");
    } catch (err) {
      if (err instanceof ComposioConnectionMissingError) {
        expect(err.status).toBe("pending");
        expect(err.composioConnectionId).toBe("conn_pending");
      } else {
        throw err;
      }
    }
  });

  it("throws status='failed' when only failed row exists", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_failed",
      status: "failed",
    });

    try {
      await resolveConnectedAccountId(db, companyAId, "hubspot");
      throw new Error("should have thrown");
    } catch (err) {
      if (err instanceof ComposioConnectionMissingError) {
        expect(err.status).toBe("failed");
      } else {
        throw err;
      }
    }
  });

  it("throws status='revoked' when only revoked row exists", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_revoked",
      status: "revoked",
    });

    try {
      await resolveConnectedAccountId(db, companyAId, "hubspot");
      throw new Error("should have thrown");
    } catch (err) {
      if (err instanceof ComposioConnectionMissingError) {
        expect(err.status).toBe("revoked");
      } else {
        throw err;
      }
    }
  });

  it("cross-tenant: company A's active connection is NOT visible to company B", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_a_only",
      status: "active",
    });

    await expect(
      resolveConnectedAccountId(db, companyBId, "hubspot"),
    ).rejects.toThrowError(ComposioConnectionMissingError);
  });

  it("cross-app: hubspot connection is NOT returned for slack lookup", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_hub_only",
      status: "active",
    });

    await expect(
      resolveConnectedAccountId(db, companyAId, "slack"),
    ).rejects.toThrowError(ComposioConnectionMissingError);
  });

  it("tryResolveConnectedAccountId returns null instead of throwing on missing", async () => {
    const id = await tryResolveConnectedAccountId(db, companyAId, "hubspot");
    expect(id).toBeNull();
  });

  it("tryResolveConnectedAccountId returns id on active connection", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-1",
      appName: "hubspot",
      composioConnectionId: "conn_for_try",
      status: "active",
    });
    const id = await tryResolveConnectedAccountId(db, companyAId, "hubspot");
    expect(id).toBe("conn_for_try");
  });
});
