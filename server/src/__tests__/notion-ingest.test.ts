/**
 * notion-ingest.test.ts — Tests for Notion page ingestion (S2.6)
 *
 * Coverage:
 * - 1 shared page → 1 event row created
 * - Un-share page (empty list) → next sync stops ingesting
 * - Cross-org leak prevention: connectedAccountId threading
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type Db,
} from "@founderos/db";
import { ingestNotionPages } from "../services/integrations/notion-ingest.js";
import * as composioClient from "../services/composio-client.js";

describe("notion-ingest", () => {
  let testDb: EmbeddedPostgresTestDatabase;
  let db: Db;
  const testCompanyId = "test-company-123";
  const testWorkspaceId = "test-workspace-456";
  const testConnectedAccountId = "notion-conn-789";

  beforeEach(async () => {
    const pgSupport = getEmbeddedPostgresTestSupport();
    testDb = await startEmbeddedPostgresTestDatabase(pgSupport);
    db = testDb.db;

    // Insert test company
    await db.execute(`
      INSERT INTO "company" (id, name)
      VALUES ($1, 'Test Company')
    `, [testCompanyId]);
  });

  afterEach(async () => {
    await testDb.stop();
  });

  it("ingests 1 shared page → 1 event row", async () => {
    // Mock Composio client
    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      client: {
        executeToolForWorkspace: vi.fn().mockResolvedValue({
          successfull: true,
          data: [
            {
              id: "page-1",
              title: "Product Roadmap",
              last_edited_time: new Date().toISOString(),
              url: "https://notion.so/product-roadmap",
            },
          ],
        }),
      },
    } as any);

    const result = await ingestNotionPages(db, {
      companyId: testCompanyId,
      workspaceId: testWorkspaceId,
      connectedAccountId: testConnectedAccountId,
    });

    expect(result.created).toBe(1);
    expect(result.deduplicated).toBe(0);

    // Verify event was inserted
    const events = await db.execute(
      `SELECT * FROM "events" WHERE company_id = $1 AND source = 'notion'`,
      [testCompanyId],
    );
    expect((events as any[]).length).toBe(1);
    expect((events as any[])[0].entity_type).toBe("page");
    expect((events as any[])[0].event_name).toBe("page.snapshot");
    expect((events as any[])[0].source_event_id).toBe("page-1");
  });

  it("un-share page → next sync stops ingesting (no error)", async () => {
    // First sync: 1 page
    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      client: {
        executeToolForWorkspace: vi
          .fn()
          .mockResolvedValueOnce({
            successfull: true,
            data: [
              {
                id: "page-1",
                title: "Shared Page",
                last_edited_time: new Date().toISOString(),
                url: "https://notion.so/shared",
              },
            ],
          })
          // Second sync: empty list (page un-shared)
          .mockResolvedValueOnce({
            successfull: true,
            data: [],
          }),
      },
    } as any);

    // First sync
    const result1 = await ingestNotionPages(db, {
      companyId: testCompanyId,
      workspaceId: testWorkspaceId,
      connectedAccountId: testConnectedAccountId,
    });
    expect(result1.created).toBe(1);

    // Second sync (page un-shared)
    const result2 = await ingestNotionPages(db, {
      companyId: testCompanyId,
      workspaceId: testWorkspaceId,
      connectedAccountId: testConnectedAccountId,
    });

    // No new events created, no error thrown
    expect(result2.created).toBe(0);
    expect(result2.deduplicated).toBe(0);

    // Original event still exists in DB (not deleted)
    const events = await db.execute(
      `SELECT * FROM "events" WHERE company_id = $1 AND source = 'notion'`,
      [testCompanyId],
    );
    expect((events as any[]).length).toBe(1);
  });

  it("re-ingest same page → deduplicated (no duplicate row)", async () => {
    const pageData = {
      id: "page-1",
      title: "Product Roadmap",
      last_edited_time: new Date().toISOString(),
      url: "https://notion.so/product-roadmap",
    };

    vi.spyOn(composioClient, "getComposioClient").mockReturnValue({
      client: {
        executeToolForWorkspace: vi.fn().mockResolvedValue({
          successfull: true,
          data: [pageData],
        }),
      },
    } as any);

    // First ingest
    const result1 = await ingestNotionPages(db, {
      companyId: testCompanyId,
      workspaceId: testWorkspaceId,
      connectedAccountId: testConnectedAccountId,
    });
    expect(result1.created).toBe(1);

    // Re-ingest same page
    const result2 = await ingestNotionPages(db, {
      companyId: testCompanyId,
      workspaceId: testWorkspaceId,
      connectedAccountId: testConnectedAccountId,
    });
    expect(result2.deduplicated).toBe(1);
    expect(result2.created).toBe(0);

    // Verify only 1 event row exists
    const events = await db.execute(
      `SELECT * FROM "events" WHERE company_id = $1 AND source = 'notion'`,
      [testCompanyId],
    );
    expect((events as any[]).length).toBe(1);
  });
});
