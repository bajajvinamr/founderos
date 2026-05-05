/**
 * hubspot-ingest.test.ts — HubSpot read path tests (S2.5)
 *
 * Covers:
 *   (a) First sync pulls all contacts within 90d cap
 *   (b) Subsequent sync only fetches deltas after watermark
 *   (c) Lifecycle stage changes ingest as new events (not dedup on contact id alone)
 *   (d) Cross-org leak regression — workspace A's sync never sees workspace B contacts
 *       (mock 401 on wrong connectedAccountId)
 *   (e) Deal events (stage_changed, closed_won, closed_lost) are ingested correctly
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  composioConnections,
  events,
  createDb,
} from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hubspotIngestService } from "../services/integrations/hubspot-ingest.js";
import * as composioClient from "../services/composio-client.js";
import { initEventIngest } from "../services/event-ingest.js";

/**
 * Generate a unique 6-char alpha issue prefix per test row.
 *
 * `companies.issue_prefix` has a UNIQUE index (`companies_issue_prefix_idx`)
 * with default `'PAP'`. Inserting two rows in the same test without overriding
 * the default collides. Random 6-letter prefixes give ~308M unique values, so
 * collisions across tests in the same shared DB are negligible.
 */
function uniqueIssuePrefix(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping hubspot-ingest tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("hubspot-ingest service — watermarking + cross-org leak prevention", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyAId!: string;
  let companyBId!: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-hubspot-ingest-");
    db = createDb(temp.connectionString);
    // Bind module-level `ingestEvent()` singleton to the test db.
    // hubspotIngestService -> ingestEvent() (singleton import) -> would throw
    // "event-ingest not initialized" without this. The throw is swallowed by
    // the per-contact try/catch, leaving contactsProcessed=0 and silent assert
    // failures downstream.
    initEventIngest(db);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Truncate in FK order: events → composio_connections → companies
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "composio_connections" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    // Create two test companies for cross-org leak testing.
    // Each row needs a unique issuePrefix — UNIQUE index on companies.issue_prefix
    // means the second row can't reuse the schema default 'PAP'.
    const [companyA] = await db
      .insert(companies)
      .values({ name: "Company A", issuePrefix: uniqueIssuePrefix() })
      .returning({ id: companies.id });
    companyAId = companyA!.id;

    const [companyB] = await db
      .insert(companies)
      .values({ name: "Company B", issuePrefix: uniqueIssuePrefix() })
      .returning({ id: companies.id });
    companyBId = companyB!.id;
  });

  // ── (a) First sync pulls all contacts within 90d cap ─────────────────────

  it("(a) first sync pulls all contacts modified within 90d lookback", async () => {
    // Setup: Create Company A's HubSpot connection
    const [connA] = await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot",
        status: "active",
      })
      .returning();

    // Mock Composio execution to return contacts
    const mockExecute = vi.spyOn(composioClient, "executeTool").mockResolvedValue({
      ok: true,
      output: {
        data: {
          contacts: [
            {
              id: "contact_001",
              properties: {
                email: "alice@example.com",
                firstname: "Alice",
                lifecyclestage: "subscriber",
                hs_lastmodifieddate: new Date().toISOString(),
              },
              archived: false,
            },
          ],
        },
      },
    });

    // Mock the deals fetch to return empty (we're focusing on contacts here)
    vi.spyOn(composioClient, "executeTool").mockImplementation(async (input) => {
      if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
        return {
          ok: true,
          output: {
            data: {
              contacts: [
                {
                  id: "contact_001",
                  properties: {
                    email: "alice@example.com",
                    firstname: "Alice",
                    lifecyclestage: "subscriber",
                    hs_lastmodifieddate: new Date().toISOString(),
                  },
                  archived: false,
                },
              ],
            },
          },
        };
      }
      if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
        return {
          ok: true,
          output: {
            data: {
              deals: [],
            },
          },
        };
      }
      throw new Error(`Unexpected tool: ${input.toolName}`);
    });

    const result = await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    expect(result.contactsProcessed).toBe(1);
    expect(result.dealsProcessed).toBe(0);

    // Verify the contact event was ingested
    const contactEvents = await db
      .select()
      .from(events)
      .where(sql`company_id = ${companyAId} AND source = 'hubspot' AND entity_type = 'contact'`);
    expect(contactEvents).toHaveLength(1);
    expect(contactEvents[0].eventName).toBe("contact.created");
    expect(contactEvents[0].dedupKey).toContain("contact_001");

    mockExecute.mockRestore();
  });

  // ── (b) Subsequent sync only fetches deltas after watermark ──────────────

  it("(b) subsequent sync only fetches contacts modified after watermark", async () => {
    // Setup: Create Company A's HubSpot connection with an old updatedAt
    const oldTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const [connA] = await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot",
        status: "active",
        updatedAt: oldTime,
      })
      .returning();

    // Mock: contacts before watermark should be skipped
    vi.spyOn(composioClient, "executeTool").mockImplementation(async (input) => {
      if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
        return {
          ok: true,
          output: {
            data: {
              contacts: [
                {
                  id: "old_contact",
                  properties: {
                    email: "old@example.com",
                    hs_lastmodifieddate: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
                    lifecyclestage: "subscriber",
                  },
                  archived: false,
                },
                {
                  id: "new_contact",
                  properties: {
                    email: "new@example.com",
                    hs_lastmodifieddate: new Date().toISOString(), // just now
                    lifecyclestage: "subscriber",
                  },
                  archived: false,
                },
              ],
            },
          },
        };
      }
      if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
        return {
          ok: true,
          output: { data: { deals: [] } },
        };
      }
      throw new Error(`Unexpected tool: ${input.toolName}`);
    });

    const result = await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    // Only the new contact (modified after watermark) should be ingested
    expect(result.contactsProcessed).toBe(1);

    const contactEvents = await db
      .select()
      .from(events)
      .where(sql`company_id = ${companyAId} AND source = 'hubspot'`);
    expect(contactEvents).toHaveLength(1);
    expect(contactEvents[0].dedupKey).toContain("new_contact");
  });

  // ── (c) Lifecycle stage changes ingest as new events ────────────────────

  it("(c) lifecycle stage changes generate contact.lifecycle_changed events (not dedup on id alone)", async () => {
    const [connA] = await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot",
        status: "active",
        updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      })
      .returning();

    vi.spyOn(composioClient, "executeTool").mockImplementation(async (input) => {
      if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
        return {
          ok: true,
          output: {
            data: {
              contacts: [
                {
                  id: "contact_xyz",
                  properties: {
                    email: "bob@example.com",
                    lifecyclestage: "lead",
                    hs_lastmodifieddate: new Date().toISOString(),
                  },
                  archived: false,
                },
              ],
            },
          },
        };
      }
      if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
        return {
          ok: true,
          output: { data: { deals: [] } },
        };
      }
      throw new Error(`Unexpected tool: ${input.toolName}`);
    });

    await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    const contactEvents = await db
      .select()
      .from(events)
      .where(sql`company_id = ${companyAId} AND entity_type = 'contact'`);
    expect(contactEvents).toHaveLength(1);
    expect(contactEvents[0].eventName).toBe("contact.lifecycle_changed"); // lead → lifecycle change, not created
    expect(contactEvents[0].dedupKey).toBe("contact_xyz:lead"); // Dedup key includes stage
  });

  // ── (d) Cross-org leak regression ───────────────────────────────────────

  it("(d) workspace A sync never executes with workspace B's connectedAccountId (prevents cross-org leak)", async () => {
    // Setup: Company A and Company B both have HubSpot connections
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-a",
      appName: "hubspot",
      composioConnectionId: "conn_a_hubspot",
      status: "active",
    });

    await db.insert(composioConnections).values({
      companyId: companyBId,
      userId: "user-b",
      appName: "hubspot",
      composioConnectionId: "conn_b_hubspot",
      status: "active",
    });

    const executeSpy = vi.spyOn(composioClient, "executeTool");
    executeSpy.mockImplementation(async (input) => {
      // Simulate: if the wrong connectedAccountId is used, Composio returns 401
      if (
        input.connectedAccountId === "conn_b_hubspot" &&
        input.userId === "user-a"
      ) {
        return {
          ok: false,
          reason: "composio_error",
          message: "401 Unauthorized — connection not owned by this user",
        };
      }

      // Success path for correct connectedAccountId
      if (input.connectedAccountId === "conn_a_hubspot") {
        if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
          return {
            ok: true,
            output: {
              data: {
                contacts: [
                  {
                    id: "a_contact",
                    properties: {
                      email: "a@example.com",
                      lifecyclestage: "subscriber",
                      hs_lastmodifieddate: new Date().toISOString(),
                    },
                    archived: false,
                  },
                ],
              },
            },
          };
        }
        if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
          return {
            ok: true,
            output: { data: { deals: [] } },
          };
        }
      }

      throw new Error(`Unexpected combination: ${input.toolName}`);
    });

    // Run sync for Company A
    await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    // Verify: All calls used conn_a_hubspot
    const callsWithConnId = executeSpy.mock.calls.filter(
      ([input]) => "connectedAccountId" in input,
    );
    expect(callsWithConnId.length).toBeGreaterThan(0);
    for (const [input] of callsWithConnId) {
      if ("connectedAccountId" in input) {
        expect(input.connectedAccountId).toBe("conn_a_hubspot");
      }
    }

    // Verify: Only Company A's contacts were ingested
    const allEvents = await db.select().from(events);
    expect(allEvents.filter((e) => e.companyId === companyAId)).toHaveLength(1);
    expect(allEvents.filter((e) => e.companyId === companyBId)).toHaveLength(0);

    executeSpy.mockRestore();
  });

  // ── (e) Deal events are ingested correctly ───────────────────────────────

  it("(e) deal events (stage_changed, closed_won, closed_lost) are ingested as distinct dedupKeys", async () => {
    await db.insert(composioConnections).values({
      companyId: companyAId,
      userId: "user-a",
      appName: "hubspot",
      composioConnectionId: "conn_a_hubspot",
      status: "active",
    });

    vi.spyOn(composioClient, "executeTool").mockImplementation(async (input) => {
      if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
        return {
          ok: true,
          output: { data: { contacts: [] } },
        };
      }
      if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
        return {
          ok: true,
          output: {
            data: {
              deals: [
                {
                  id: "deal_001",
                  properties: {
                    dealname: "Big Deal",
                    dealstage: "negotiation",
                    amount: "50000",
                    hs_lastmodifieddate: new Date().toISOString(),
                  },
                  archived: false,
                },
                {
                  id: "deal_002",
                  properties: {
                    dealname: "Won Deal",
                    dealstage: "closedwon",
                    amount: "100000",
                    hs_lastmodifieddate: new Date().toISOString(),
                  },
                  archived: false,
                },
                {
                  id: "deal_003",
                  properties: {
                    dealname: "Lost Deal",
                    dealstage: "closedlost",
                    hs_lastmodifieddate: new Date().toISOString(),
                  },
                  archived: false,
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected tool: ${input.toolName}`);
    });

    const result = await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    expect(result.dealsProcessed).toBe(3);

    const dealEvents = await db
      .select()
      .from(events)
      .where(sql`company_id = ${companyAId} AND entity_type = 'deal'`);

    expect(dealEvents).toHaveLength(3);
    expect(dealEvents.map((e) => e.eventName).sort()).toEqual([
      "deal.closed_lost",
      "deal.closed_won",
      "deal.stage_changed",
    ]);

    // Verify dedupKey includes stage (so stage changes don't dedup on id alone)
    expect(dealEvents[0].dedupKey).toMatch(/^deal_\d{3}:[a-z]+$/);
  });

  // ── (f) Council 2026-05-05 P2 (C2) — inactive connections must be skipped ──
  //
  // Trust contract: the cron iterates only `status="active"` rows, but the
  // service is also reachable via manual triggers (admin "sync now"). Without
  // a status filter at the service boundary, a manual sync against a workspace
  // whose hubspot connection is `revoked` / `error` / `disconnected` would
  // bind to the stale connectedAccountId and either leak data or 401-loop.
  // Defense in depth: the filter belongs at both the cron AND the service.

  it("(f) inactive HubSpot connections are not bound to during ingest (status=active filter at service boundary)", async () => {
    // Setup: insert a REVOKED hubspot connection for Company A — should be skipped.
    await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot_revoked",
        status: "revoked",
      })
      .returning();

    // Mock executeTool to fail loudly if it's ever called — proves the
    // service short-circuited on the no-active-connection branch.
    const mockExecute = vi.spyOn(composioClient, "executeTool").mockImplementation(async () => {
      throw new Error("executeTool must NOT be called for inactive connections");
    });

    const result = await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    expect(result.contactsProcessed).toBe(0);
    expect(result.dealsProcessed).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();

    // No events should have been ingested.
    const evRows = await db
      .select()
      .from(events)
      .where(sql`company_id = ${companyAId} AND source = 'hubspot'`);
    expect(evRows).toHaveLength(0);

    mockExecute.mockRestore();
  });

  // ── (g) Council 2026-05-05 P2 (C2) — disambiguates inactive vs active ────
  //
  // When BOTH an inactive and an active connection exist for the same company,
  // the service must pick the active one (status="active" filter), not the
  // first row by insertion order or PK. This is the realistic post-rotation
  // shape: founder reconnects → old row stays as `revoked` → new row is `active`.

  it("(g) when active and inactive HubSpot rows coexist, the active one is selected", async () => {
    // Realistic multi-admin scenario: original admin's connection got revoked
    // (`user-a-old`), and a second admin (`user-a-new`) reconnected. The
    // unique constraint (companyId, userId, appName) prevents two rows per
    // user — so this is the shape we'd see across user changes, not a
    // "rotate same user" case.

    // First admin's old, revoked row
    await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a-old",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot_OLD",
        status: "revoked",
      })
      .returning();

    // Second admin's new, active row
    await db
      .insert(composioConnections)
      .values({
        companyId: companyAId,
        userId: "user-a-new",
        appName: "hubspot",
        composioConnectionId: "conn_a_hubspot_NEW",
        status: "active",
      })
      .returning();

    const seenAccountIds: string[] = [];
    const mockExecute = vi.spyOn(composioClient, "executeTool").mockImplementation(async (input: any) => {
      if (input.connectedAccountId) seenAccountIds.push(input.connectedAccountId);
      if (input.toolName === "HUBSPOT_CRM_GET_CONTACTS") {
        return { ok: true, output: { data: { contacts: [] } } };
      }
      if (input.toolName === "HUBSPOT_CRM_GET_DEALS") {
        return { ok: true, output: { data: { deals: [] } } };
      }
      throw new Error(`Unexpected tool: ${input.toolName}`);
    });

    await hubspotIngestService({
      companyId: companyAId,
      db,
    });

    // Every executeTool invocation must use the NEW (active) connectedAccountId.
    expect(seenAccountIds.length).toBeGreaterThan(0);
    for (const accountId of seenAccountIds) {
      expect(accountId).toBe("conn_a_hubspot_NEW");
    }
    expect(seenAccountIds).not.toContain("conn_a_hubspot_OLD");

    mockExecute.mockRestore();
  });
});
