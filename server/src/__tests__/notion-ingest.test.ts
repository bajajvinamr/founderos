/**
 * notion-ingest.test.ts — Tests for Notion page ingestion (S2.6)
 *
 * Coverage:
 * - 1 shared page → 1 event row created
 * - Un-share page (empty list) → next sync stops ingesting (no error)
 * - Re-ingest same page → deduplicated, no duplicate row
 *
 * Test infra notes (closes #125):
 *   Same fixture-shape mismatch as slack-ingest.test.ts. Original agent assumed
 *   `startEmbeddedPostgresTestDatabase` returns `{ db, stop }`; the actual API
 *   is `{ connectionString, cleanup }` and tests must instantiate Drizzle from
 *   the connection string. Composio mock is corrected to v3 shape:
 *   `executeTool({ userId, toolName, params, connectedAccountId }) → { ok, output }`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, events, createDb } from "@founderos/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ingestNotionPages } from "../services/integrations/notion-ingest.js";
import * as composioClient from "../services/composio-client.js";
import { initEventIngest } from "../services/event-ingest.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping notion-ingest tests: ${support.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("notion-ingest service — page snapshot, dedup, un-share handling", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const workspaceId = "test-workspace-456";
  const connectedAccountId = "notion-conn-789";

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("founderos-notion-ingest-");
    db = createDb(temp.connectionString);
    // ingestNotionPages calls module-level ingestEvent() (singleton). Bind to
    // the test db so the singleton resolves; otherwise it throws and `created`
    // stays 0 silently because the per-page try/catch swallows it.
    initEventIngest(db);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "events" CASCADE`);
    await db.execute(sql`TRUNCATE TABLE "companies" CASCADE`);

    const [company] = await db
      .insert(companies)
      .values({ name: "Test Company", issuePrefix: uniqueIssuePrefix() })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  it("ingests 1 shared page → 1 event row", async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      ok: true,
      output: {
        pages: [
          {
            id: "page-1",
            title: "Product Roadmap",
            last_edited_time: new Date().toISOString(),
            url: "https://notion.so/product-roadmap",
          },
        ],
      },
    });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result = await ingestNotionPages(db, {
      companyId,
      workspaceId,
      connectedAccountId,
    });

    expect(result.created).toBe(1);
    expect(result.deduplicated).toBe(0);

    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.source} = 'notion'`);
    expect(rows.length).toBe(1);
    expect(rows[0].entityType).toBe("page");
    expect(rows[0].eventName).toBe("page.snapshot");
    expect(rows[0].dedupKey).toBe("page-1");
  });

  it("un-share page → next sync stops ingesting (no error)", async () => {
    const mockExecute = vi
      .fn()
      // First sync: 1 page accessible
      .mockResolvedValueOnce({
        ok: true,
        output: {
          pages: [
            {
              id: "page-1",
              title: "Shared Page",
              last_edited_time: new Date().toISOString(),
              url: "https://notion.so/shared",
            },
          ],
        },
      })
      // Second sync: page un-shared, empty list returned
      .mockResolvedValueOnce({
        ok: true,
        output: { pages: [] },
      });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result1 = await ingestNotionPages(db, {
      companyId,
      workspaceId,
      connectedAccountId,
    });
    expect(result1.created).toBe(1);

    const result2 = await ingestNotionPages(db, {
      companyId,
      workspaceId,
      connectedAccountId,
    });
    // No new events created, no error thrown
    expect(result2.created).toBe(0);
    expect(result2.deduplicated).toBe(0);

    // Original event still present (un-share doesn't delete history)
    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.source} = 'notion'`);
    expect(rows.length).toBe(1);
  });

  it("re-ingest same page → deduplicated (no duplicate row)", async () => {
    const pageData = {
      id: "page-1",
      title: "Product Roadmap",
      last_edited_time: new Date().toISOString(),
      url: "https://notion.so/product-roadmap",
    };

    const mockExecute = vi.fn().mockResolvedValue({
      ok: true,
      output: { pages: [pageData] },
    });

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      executeTool: mockExecute,
      initiateConnection: vi.fn(),
      getConnection: vi.fn(),
    });

    const result1 = await ingestNotionPages(db, {
      companyId,
      workspaceId,
      connectedAccountId,
    });
    expect(result1.created).toBe(1);

    const result2 = await ingestNotionPages(db, {
      companyId,
      workspaceId,
      connectedAccountId,
    });
    expect(result2.deduplicated).toBe(1);
    expect(result2.created).toBe(0);

    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.source} = 'notion'`);
    expect(rows.length).toBe(1);
  });
});
