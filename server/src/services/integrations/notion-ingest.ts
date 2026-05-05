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
    if (!composio) {
      logger.warn(
        { companyId, workspaceId },
        "notion-ingest: Composio client not configured (COMPOSIO_API_KEY missing); skipping",
      );
      return { created: 0, deduplicated: 0 };
    }

    // List pages the founder explicitly granted access to.
    // Composio Notion API: notion_list_pages returns only accessible pages.
    // ⚠ Council 2026-05-05: this Composio call shape needs human QA — original
    //   agent wrote against a non-existent `composio.client.executeToolForWorkspace`
    //   shape. Translated to actual `executeTool` v3 API; the tool slug and
    //   response shape need to be verified against live Composio behavior.
    const listPagesResponse = await composio.executeTool({
      userId: workspaceId,
      connectedAccountId,
      toolName: "NOTION_LIST_PAGES",
      params: {},
    });

    if (!listPagesResponse.ok) {
      logger.warn(
        { companyId, workspaceId, connectedAccountId, reason: listPagesResponse.reason, message: listPagesResponse.message },
        "notion-ingest: notion_list_pages returned unsuccessful",
      );
      return { created: 0, deduplicated: 0 };
    }

    const output = listPagesResponse.output as { pages?: unknown[] } | unknown[];
    const pages = Array.isArray(output)
      ? output
      : Array.isArray(output?.pages)
      ? output.pages
      : [];

    if (!Array.isArray(pages)) {
      logger.warn(
        { companyId, workspaceId, response: listPagesResponse },
        "notion-ingest: notion_list_pages returned non-array pages",
      );
      return { created: 0, deduplicated: 0 };
    }

    let created = 0;
    let deduplicated = 0;

    for (const rawPage of pages) {
      const page = rawPage as Record<string, unknown>;
      const pageId = String(page.id ?? "");
      if (!pageId) continue;
      const title = String(page.title ?? page.name ?? "(untitled)");
      const lastEditedTime = (page.last_edited_time as string | Date | undefined) ?? new Date();
      const url = String(page.url ?? "");

      const result = await ingestEvent({
        companyId,
        source: "notion",
        entityType: "page",
        eventName: "page.snapshot",
        dedupKey: pageId,
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
