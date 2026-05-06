/**
 * slack-ingest.test.ts — Tests for Slack message ingestion (S2.6)
 *
 * Coverage:
 * - PII redaction unit tests (pure function, no DB)
 * - Bot in 2 channels → only those 2 channels ingested
 * - DM channel (is_im) never ingested
 * - Email redaction in stored payload
 * - Cross-org regression: workspace A's sync never sees workspace B's messages
 *
 * Test infra notes (closes #125):
 *   The original S2.6 agent assumed `startEmbeddedPostgresTestDatabase` returned
 *   `{ db, stop }` and that `db.execute(rawSql, paramsArray)` accepted positional
 *   parameter binding. The actual fixture API is `{ connectionString, cleanup }`
 *   (per CLAUDE.md "Embedded-pg test fixture API"), and Drizzle's `db.execute()`
 *   takes a `sql\`\`` template literal. Tests must instantiate Drizzle from
 *   `connectionString` themselves and use Drizzle's typed insert/select API for
 *   data setup. This rewrite uses the canonical pattern from
 *   `integration-health.test.ts`.
 *
 *   Composio surface: `getComposioClient()` returns a `ComposioClient | null`
 *   with `.executeTool({ userId, toolName, params, connectedAccountId })` →
 *   `{ ok, output, ... }`. The original test mocked a non-existent
 *   `client.executeToolForWorkspace` (a v2-style imagined surface) — corrected
 *   here to the actual v3 shape.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, events, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ingestSlackMessages,
  redactEmails,
} from "../services/integrations/slack-ingest.js";
import * as composioClient from "../services/composio-client.js";
import { initEventIngest } from "../services/event-ingest.js";

// ── Pure-function unit tests (no DB needed) ─────────────────────────────────

describe("redactEmails (pure function)", () => {
  it("redacts basic email: user@example.com → [email-redacted]", () => {
    const input = "Contact support at user@example.com for help";
    expect(redactEmails(input)).toBe("Contact support at [email-redacted] for help");
  });

  it("redacts email with subdomain: user.name@sub.example.co.uk", () => {
    const input = "Reach out to john.doe@subdomain.company.co.uk for details";
    expect(redactEmails(input)).toBe("Reach out to [email-redacted] for details");
  });

  it("redacts email in middle of sentence with special chars", () => {
    const input = "Send feedback to dev+feedback@mycompany.com before Friday";
    expect(redactEmails(input)).toBe("Send feedback to [email-redacted] before Friday");
  });

  it("redacts multiple emails in one message", () => {
    const input = "CC alice@company.com and bob@company.com on the update";
    expect(redactEmails(input)).toBe(
      "CC [email-redacted] and [email-redacted] on the update",
    );
  });

  it("does not redact non-email strings like 'noemail.test'", () => {
    const input = "The test noemail.test failed and user@domain.org reported it";
    expect(redactEmails(input)).toBe(
      "The test noemail.test failed and [email-redacted] reported it",
    );
  });
});

// ── DB-backed integration tests ─────────────────────────────────────────────

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping slack-ingest DB tests: ${support.reason ?? "unsupported environment"}`,
  );
}

/**
 * Generate a unique 6-char alpha issue prefix per company row.
 * `companies.issue_prefix` has a UNIQUE index — schema default 'PAP' would
 * collide on the second insert in a test that creates multiple companies.
 */
function uniqueIssuePrefix(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

describeEmbeddedPostgres("slack-ingest service — channel filtering, PII redaction, cross-org isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyAId!: string;
  let companyBId!: string;
  const workspaceId = "test-workspace-789";
  const connectedAccountId = "slack-conn-abc";

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-slack-ingest-");
    db = createDb(temp.connectionString);
    // ingestSlackMessages → module-level ingestEvent() (singleton). Without
    // this bind, the singleton throws "not initialized" inside the per-message
    // try/catch, leaving created=0 with no clear signal to the test.
    initEventIngest(db);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    // Truncate in FK order: events → companies (companies CASCADE handles rest).
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

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

  it("bot in 2 channels → only those 2 channels ingested", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Mock the Composio client per the v3 ComposioClient interface:
    //   { executeTool({ userId, toolName, connectedAccountId, params }) }
    //     → { ok: true, output: <tool-specific> }
    const mockExecute = vi
      .fn()
      // SLACK_LIST_CHANNELS
      .mockResolvedValueOnce({
        ok: true,
        output: {
          channels: [
            { id: "C001", name: "general", is_im: false, channel_type: "public" },
            { id: "C002", name: "engineering", is_im: false, channel_type: "public" },
          ],
        },
      })
      // SLACK_FETCH_MESSAGES (C001)
      .mockResolvedValueOnce({
        ok: true,
        output: {
          messages: [{ ts: String(now), text: "Hello general", user: "U123" }],
        },
      })
      // SLACK_FETCH_MESSAGES (C002)
      .mockResolvedValueOnce({
        ok: true,
        output: {
          messages: [
            { ts: String(now - 3600), text: "Engineering standup", user: "U456" },
          ],
        },
      });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result = await ingestSlackMessages(db, {
      companyId: companyAId,
      workspaceId,
      connectedAccountId,
    });

    expect(result.created).toBe(2);

    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyAId} AND ${events.source} = 'slack'`);
    expect(rows.length).toBe(2);
    const channelIds = rows
      .map((r) => (r.payload as { channelId: string }).channelId)
      .sort();
    expect(channelIds).toEqual(["C001", "C002"]);
  });

  it("skips DM channel (is_im = true)", async () => {
    const now = Math.floor(Date.now() / 1000);

    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        output: {
          channels: [
            { id: "C001", name: "general", is_im: false, channel_type: "public" },
            { id: "D123", name: "direct-message", is_im: true },
          ],
        },
      })
      // Only C001 should be fetched (DM filtered out)
      .mockResolvedValueOnce({
        ok: true,
        output: {
          messages: [{ ts: String(now), text: "Public message", user: "U789" }],
        },
      });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result = await ingestSlackMessages(db, {
      companyId: companyAId,
      workspaceId,
      connectedAccountId,
    });

    expect(result.created).toBe(1);
    // The mock should only have been called for C001's messages, not D123's.
    // 1 list + 1 fetch = 2 calls; 0 fetches for the DM.
    expect(mockExecute).toHaveBeenCalledTimes(2);

    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyAId} AND ${events.source} = 'slack'`);
    expect(rows.length).toBe(1);
    expect((rows[0].payload as { channelId: string }).channelId).toBe("C001");
  });

  it("redacts emails in messages before storing", async () => {
    const now = Math.floor(Date.now() / 1000);

    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        output: {
          channels: [{ id: "C001", name: "general", is_im: false }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: {
          messages: [
            {
              ts: String(now),
              text: "Contact john@example.com or alice@company.org",
              user: "U123",
            },
          ],
        },
      });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result = await ingestSlackMessages(db, {
      companyId: companyAId,
      workspaceId,
      connectedAccountId,
    });

    expect(result.created).toBe(1);

    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyAId} AND ${events.source} = 'slack'`);
    expect(rows.length).toBe(1);
    expect((rows[0].payload as { text: string }).text).toBe(
      "Contact [email-redacted] or [email-redacted]",
    );
  });

  it("cross-org regression: workspace A's sync never sees workspace B's messages", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Two separate sync calls — the test asserts each company only ever sees
    // its own connected-account-scoped data. The mock returns different
    // channel IDs and texts depending on the connectedAccountId argument so
    // we can verify cross-contamination is impossible at the ingest layer.
    const mockExecute = vi
      .fn()
      .mockImplementation(
        async (input: { connectedAccountId?: string; toolName: string }) => {
          const isA = input.connectedAccountId === connectedAccountId;
          if (input.toolName === "SLACK_LIST_CHANNELS") {
            return {
              ok: true,
              output: {
                channels: [
                  isA
                    ? { id: "C_A", name: "company-a-channel", is_im: false }
                    : { id: "C_B", name: "company-b-channel", is_im: false },
                ],
              },
            };
          }
          if (input.toolName === "SLACK_FETCH_MESSAGES") {
            return {
              ok: true,
              output: {
                messages: [
                  {
                    ts: String(now),
                    text: isA ? "Company A secret" : "Company B secret",
                    user: isA ? "U_A" : "U_B",
                  },
                ],
              },
            };
          }
          return { ok: false, reason: "composio_error" as const, message: "unexpected" };
        },
      );

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    // Sync company A
    const resultA = await ingestSlackMessages(db, {
      companyId: companyAId,
      workspaceId,
      connectedAccountId,
    });
    expect(resultA.created).toBe(1);

    // Sync company B with a different connected account
    const resultB = await ingestSlackMessages(db, {
      companyId: companyBId,
      workspaceId,
      connectedAccountId: "slack-conn-different",
    });
    expect(resultB.created).toBe(1);

    const eventsA = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyAId} AND ${events.source} = 'slack'`);
    expect(eventsA.length).toBe(1);
    expect((eventsA[0].payload as { channelId: string; text: string }).channelId).toBe(
      "C_A",
    );
    expect((eventsA[0].payload as { channelId: string; text: string }).text).toBe(
      "Company A secret",
    );

    const eventsB = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyBId} AND ${events.source} = 'slack'`);
    expect(eventsB.length).toBe(1);
    expect((eventsB[0].payload as { channelId: string; text: string }).channelId).toBe(
      "C_B",
    );
    expect((eventsB[0].payload as { channelId: string; text: string }).text).toBe(
      "Company B secret",
    );
  });
});
