/**
 * Notion sync service.
 *
 * Pulls recent pages from a connected Notion workspace, then writes a
 * compact summary row into the integration_data table (upsert). On success
 * marks the integration as "connected"; on failure flips status to "error"
 * and stores the message.
 *
 * Mirrors the shape of hubspot-sync.ts.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrationData, integrations } from "@founderos/db";
import {
  createNotionClient,
  NotionAuthError,
  type NotionPage,
  type NotionProperty,
  type NotionTitleProperty,
} from "./notion-client.js";
import { logger } from "../middleware/logger.js";

export type SyncResult =
  | { ok: true; synced: string[] }
  | { ok: false; error: string };

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface NotionPageCard {
  id: string;
  title: string;
  url: string;
  lastEditedAt: string;
  createdAt: string;
  snippet: string; // short text snippet (currently title-derived)
  archived: boolean;
}

export interface NotionPagesPayload {
  totalPages: number;
  pages: NotionPageCard[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SNIPPET_MAX_LEN = 200;

function isTitleProperty(prop: NotionProperty): prop is NotionTitleProperty {
  return prop.type === "title" && Array.isArray((prop as NotionTitleProperty).title);
}

/**
 * Extract a page title from Notion's properties map. Notion stores the title
 * under a property whose `type === "title"`; the name of that property is
 * workspace-defined (often "Name" or "title"). We scan for the first title
 * property and concatenate its rich_text plain_text fragments.
 */
export function extractPageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (isTitleProperty(prop)) {
      const text = prop.title
        .map((t) => t.plain_text ?? "")
        .join("")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return "(untitled)";
}

function buildSnippet(title: string): string {
  if (title.length <= SNIPPET_MAX_LEN) return title;
  return `${title.slice(0, SNIPPET_MAX_LEN - 1).trimEnd()}…`;
}

export function buildPageCard(page: NotionPage): NotionPageCard {
  const title = extractPageTitle(page);
  return {
    id: page.id,
    title,
    url: page.url,
    lastEditedAt: page.last_edited_time,
    createdAt: page.created_time,
    snippet: buildSnippet(title),
    archived: page.archived === true,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function syncNotion(params: {
  db: Db;
  integrationId: string;
  companyId: string;
  decryptedApiKey: string;
}): Promise<SyncResult> {
  const { db, integrationId, companyId, decryptedApiKey } = params;

  const client = createNotionClient({ accessToken: decryptedApiKey });

  try {
    // 1. Health check — also validates the token.
    await client.getMe();

    // 2. Pull up to N recent pages sorted by last_edited_time desc.
    const rawPages = await client.searchPages();

    // 3. Shape into summary cards, filter out archived pages for the UI view.
    const pageCards: NotionPageCard[] = rawPages
      .map(buildPageCard)
      .filter((p) => !p.archived);

    const payload: NotionPagesPayload = {
      totalPages: pageCards.length,
      pages: pageCards,
    };

    const now = new Date();

    // 4. Upsert into integration_data (kind = "notion.pages").
    await db
      .insert(integrationData)
      .values({
        companyId,
        integrationId,
        kind: "notion.pages",
        payload: payload as unknown as Record<string, unknown>,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          integrationData.companyId,
          integrationData.integrationId,
          integrationData.kind,
        ],
        set: {
          payload: sql`excluded.payload`,
          fetchedAt: sql`now()`,
        },
      });

    // 5. Mark integration as connected.
    await db
      .update(integrations)
      .set({ status: "connected", lastError: null, updatedAt: now })
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.companyId, companyId),
        ),
      );

    logger.info(
      { integrationId, companyId, totalPages: pageCards.length },
      "notion-sync: sync completed successfully",
    );

    return { ok: true, synced: ["notion.pages"] };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during Notion sync";

    if (err instanceof NotionAuthError) {
      logger.warn(
        { integrationId, companyId },
        `notion-sync: auth error — ${message}`,
      );
    } else {
      logger.error({ err, integrationId, companyId }, "notion-sync: sync failed");
    }

    try {
      await db
        .update(integrations)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.companyId, companyId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { updateErr, integrationId },
        "notion-sync: failed to update integration status to error",
      );
    }

    return { ok: false, error: message };
  }
}
