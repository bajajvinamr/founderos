/**
 * notion-ingest.ts — Notion database + page ingestion (S2.6)
 *
 * Lists pages the founder explicitly granted access to via Composio Notion connection.
 * Does NOT slurp the entire workspace — only explicitly-accessible pages.
 *
 * Privacy constraint: NEVER ingest pages not in the connected account's accessible list.
 */

import type { Db } from "@founderos/db";
import { ingestEvent } from "./event-ingest.js";
import { getComposioClient } from "../composio-client.js";
import { logger } from "../../middleware/logger.js";

export interface NotionIngestInput {
  companyId: string;
  workspaceId: string;
  connectedAccountId: string; // Cross-org leak prevention (PR #30)
}

/**
 * Ingest accessible Notion pages for the given workspace.
 *
 * @returns count of events created (deduplicated insertions not counted)
 */
export async function ingestNotionPages(
  db: Db,
  input: NotionIngestInput,
): Promise<{ created: number; deduplicated: number }> {
  const { companyId, workspaceId, connectedAccountId } = input;

  try {
    const composio = getComposioClient();

    // List pages the founder explicitly granted access to.
    // Composio Notion API: notion_list_pages returns only accessible pages.
    const listPagesResponse = await composio.client.executeToolForWorkspace({
      workspaceId,
      connectedAccountId,
      toolName: "notion_list_pages",
      executeRequest: {},
    });

    if (!listPagesResponse || !listPagesResponse.successfull) {
      logger.warn(
        { companyId, workspaceId, connectedAccountId },
        "notion-ingest: notion_list_pages returned unsuccessful",
      );
      return { created: 0, deduplicated: 0 };
    }

    const pages = Array.isArray(listPagesResponse.data)
      ? listPagesResponse.data
      : listPagesResponse.data?.pages || [];

    if (!Array.isArray(pages)) {
      logger.warn(
        { companyId, workspaceId, response: listPagesResponse },
        "notion-ingest: notion_list_pages returned non-array pages",
      );
      return { created: 0, deduplicated: 0 };
    }

    let created = 0;
    let deduplicated = 0;

    for (const page of pages) {
      const pageId = page.id;
      const title = page.title || page.name || "(untitled)";
      const lastEditedTime = page.last_edited_time || new Date();
      const url = page.url || "";

      const result = await ingestEvent({
        companyId,
        source: "notion",
        entityType: "page",
        eventName: "page.snapshot",
        sourceEventId: pageId,
        occurredAt: new Date(lastEditedTime),
        payload: {
          title,
          lastEditedTime,
          url,
          pageId,
        },
      });

      if (result.deduplicated) {
        deduplicated++;
      } else {
        created++;
      }
    }

    logger.info(
      { companyId, workspaceId, created, deduplicated },
      "notion-ingest: completed",
    );

    return { created, deduplicated };
  } catch (err) {
    logger.error(
      { err, companyId, workspaceId, connectedAccountId },
      "notion-ingest: error listing pages",
    );
    throw err;
  }
}
