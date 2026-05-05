/**
 * slack-ingest.ts — Slack channel message ingestion (S2.6)
 *
 * Lists channels the bot is invited to (via Composio Slack connection).
 * NEVER ingests user-private DMs (channel.is_im filter).
 * Applies PII redaction: email regex → [email-redacted] before storing payload.
 *
 * Privacy constraint:
 *   - Only channels bot is in (channel_type !== 'im_group', 'im', 'mpdm')
 *   - Redact emails before storage
 *   - Cross-org leak prevention via connectedAccountId
 */

import type { Db } from "@founderos/db";
import { ingestEvent } from "./event-ingest.js";
import { getComposioClient } from "../composio-client.js";
import { logger } from "../../middleware/logger.js";

export interface SlackIngestInput {
  companyId: string;
  workspaceId: string;
  connectedAccountId: string; // Cross-org leak prevention (PR #30)
}

/**
 * Email regex for PII redaction.
 * Matches: user@example.com, user.name+tag@co.uk, etc.
 * Pattern: one or more alphanumeric/dot/underscore/plus/hyphen, @, domain, .tld
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Redact email addresses in text.
 */
function redactEmails(text: string): string {
  return text.replace(EMAIL_REGEX, "[email-redacted]");
}

/**
 * Check if channel should be ingested (skip DMs and private channels).
 */
function shouldIngestChannel(
  channel: Record<string, unknown>,
): boolean {
  // Skip DMs (is_im flag or channel types ending with 'im')
  const isIm = channel.is_im === true;
  const channelType = (channel.channel_type as string) || "";
  const isDmType =
    channelType === "im" ||
    channelType === "im_group" ||
    channelType === "mpdm";

  if (isIm || isDmType) {
    return false;
  }

  return true;
}

/**
 * Ingest messages from channels the bot is in (last 24h rolling window).
 *
 * @returns count of events created (deduplicated insertions not counted)
 */
export async function ingestSlackMessages(
  db: Db,
  input: SlackIngestInput,
): Promise<{ created: number; deduplicated: number }> {
  const { companyId, workspaceId, connectedAccountId } = input;

  try {
    const composio = getComposioClient();
    if (!composio) {
      logger.warn(
        { companyId, workspaceId },
        "slack-ingest: Composio client not configured (COMPOSIO_API_KEY missing); skipping",
      );
      return { created: 0, deduplicated: 0 };
    }

    // List channels the bot is in.
    // ⚠ Council 2026-05-05: Composio call shape needs human QA — see task #124.
    const listChannelsResponse = await composio.executeTool({
      userId: workspaceId,
      connectedAccountId,
      toolName: "SLACK_LIST_CHANNELS",
      params: {},
    });

    if (!listChannelsResponse.ok) {
      logger.warn(
        { companyId, workspaceId, connectedAccountId, reason: listChannelsResponse.reason, message: listChannelsResponse.message },
        "slack-ingest: slack_list_channels returned unsuccessful",
      );
      return { created: 0, deduplicated: 0 };
    }

    const channelsOutput = listChannelsResponse.output as { channels?: unknown[] } | unknown[];
    const channels = Array.isArray(channelsOutput)
      ? channelsOutput
      : Array.isArray(channelsOutput?.channels)
      ? channelsOutput.channels
      : [];

    if (!Array.isArray(channels)) {
      logger.warn(
        { companyId, workspaceId, response: listChannelsResponse },
        "slack-ingest: slack_list_channels returned non-array channels",
      );
      return { created: 0, deduplicated: 0 };
    }

    let created = 0;
    let deduplicated = 0;

    for (const rawChannel of channels) {
      const channel = rawChannel as Record<string, unknown>;
      // Skip DMs and private channels
      if (!shouldIngestChannel(channel)) {
        continue;
      }

      const channelId = String(channel.id ?? "");
      const channelName = String(channel.name ?? "");
      if (!channelId) continue;

      try {
        // Fetch messages from the last 24h (rolling window).
        // Slack API: oldest = (now - 86400 seconds) / 1000
        const now = Math.floor(Date.now() / 1000);
        const oneDayAgo = now - 86400;

        const messagesResponse = await composio.executeTool({
          userId: workspaceId,
          connectedAccountId,
          toolName: "SLACK_FETCH_MESSAGES",
          params: {
            channel_id: channelId,
            oldest: String(oneDayAgo),
            latest: String(now),
          },
        });

        if (!messagesResponse.ok) {
          logger.warn(
            { companyId, channelId, channelName, reason: messagesResponse.reason, message: messagesResponse.message },
            "slack-ingest: slack_fetch_messages returned unsuccessful",
          );
          continue;
        }

        const messagesOutput = messagesResponse.output as { messages?: unknown[] } | unknown[];
        const messages: unknown[] = Array.isArray(messagesOutput)
          ? messagesOutput
          : Array.isArray(messagesOutput?.messages)
          ? messagesOutput.messages
          : [];

        if (!Array.isArray(messages)) {
          logger.warn(
            { companyId, channelId, response: messagesResponse },
            "slack-ingest: slack_fetch_messages returned non-array messages",
          );
          continue;
        }

        for (const rawMessage of messages) {
          const message = rawMessage as Record<string, unknown>;
          const text = String(message.text ?? "");
          const userId = String(message.user ?? "");
          const ts = String(message.ts ?? now);

          // PII redaction: strip email addresses
          const redactedText = redactEmails(text);

          // Source event ID: channel_id + message timestamp (unique per channel)
          const dedupKey = `${channelId}:${ts}`;

          const result = await ingestEvent({
            companyId,
            source: "slack",
            entityType: "message",
            eventName: "message.posted",
            dedupKey,
            occurredAt: new Date(Math.floor(parseFloat(ts) * 1000)),
            payload: {
              channelId,
              channelName,
              userId,
              text: redactedText,
              timestamp: ts,
            },
          });

          if (result.deduplicated) {
            deduplicated++;
          } else {
            created++;
          }
        }
      } catch (channelErr) {
        logger.error(
          { err: channelErr, companyId, channelId, channelName },
          "slack-ingest: error fetching messages for channel",
        );
        // Continue to next channel instead of failing the entire sync
      }
    }

    logger.info(
      { companyId, workspaceId, created, deduplicated },
      "slack-ingest: completed",
    );

    return { created, deduplicated };
  } catch (err) {
    logger.error(
      { err, companyId, workspaceId, connectedAccountId },
      "slack-ingest: error listing channels",
    );
    throw err;
  }
}

// Export redactEmails for testing
export { redactEmails };
