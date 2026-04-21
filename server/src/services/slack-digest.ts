/**
 * Slack digest service — composes and delivers the Morning Brief to Slack.
 *
 * On first delivery (no default channel configured), selects a fallback:
 * 1. Named channel: #founderos
 * 2. Named channel: #general
 * 3. First bot-accessible channel (public/private)
 *
 * Persists the selected channel to integration.config.defaultChannel
 * for future deliveries to be stable.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, companies } from "@founderos/db";
import { createSlackClient, SlackAuthError } from "./slack-client.js";
import { dashboardService } from "./dashboard.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

interface DeliverMorningBriefParams {
  db: Db;
  companyId: string;
  integrationId: string;
  decryptedBotToken: string;
}

export type DigestResult =
  | {
      ok: true;
      channel: string;
      ts: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function deliverMorningBriefToSlack(
  params: DeliverMorningBriefParams,
): Promise<DigestResult> {
  const { db, companyId, integrationId, decryptedBotToken } = params;

  try {
    // Fetch integration row
    const [integrationRow] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.companyId, companyId),
        ),
      );

    if (!integrationRow) {
      const msg = "Integration not found";
      logger.warn({ integrationId, companyId }, msg);
      return { ok: false, error: msg };
    }

    const client = createSlackClient({ botToken: decryptedBotToken });

    // Resolve default channel
    let defaultChannelId: string;
    const config = (integrationRow.config as Record<string, unknown>) ?? {};
    const storedChannelId = typeof config.defaultChannel === "string" ? config.defaultChannel : null;

    if (storedChannelId) {
      defaultChannelId = storedChannelId;
    } else {
      // Fetch available channels and pick a fallback
      let channels;
      try {
        channels = await client.listChannels();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to fetch channels";
        logger.error({ err, integrationId }, `slack-digest: listChannels failed — ${msg}`);
        return { ok: false, error: msg };
      }

      // Filter to bot-accessible channels
      const accessible = channels.filter((ch) => ch.isMember);
      if (accessible.length === 0) {
        const msg = "No accessible Slack channels found for the bot";
        logger.warn({ integrationId, companyId }, msg);
        return { ok: false, error: msg };
      }

      // Try named channels first
      const founderos = accessible.find((ch) => ch.name === "founderos");
      const general = accessible.find((ch) => ch.name === "general");
      defaultChannelId = founderos?.id ?? general?.id ?? accessible[0].id;

      // Persist choice with channels list
      const channelsList = accessible.slice(0, 20).map((ch) => ({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.isPrivate,
      }));
      const updatedConfig: Record<string, unknown> = {
        ...config,
        defaultChannel: defaultChannelId,
        channels: channelsList,
      };
      await db
        .update(integrations)
        .set({ config: updatedConfig, updatedAt: new Date() })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.companyId, companyId),
          ),
        );
    }

    // Fetch company and dashboard summary
    const [companyRow] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId));

    if (!companyRow) {
      const msg = "Company not found";
      logger.warn({ companyId }, msg);
      return { ok: false, error: msg };
    }

    let briefText: string;
    try {
      const dashboard = dashboardService(db);
      const summary = await dashboard.summary(companyId);

      const companyName = companyRow.name ?? "Your company";
      const monthSpendDollars = (summary.costs.monthSpendCents / 100).toFixed(2);
      const budgetPercent = summary.costs.monthUtilizationPercent.toFixed(0);

      const lines: string[] = [
        `*Morning Brief — ${companyName}*`,
        `Spend this month: $${monthSpendDollars} (${budgetPercent}% of budget)`,
      ];

      if (summary.pendingApprovals > 0) {
        lines.push(
          `> ${summary.pendingApprovals} approvals need your call`,
        );
      }

      const workSessions = summary.tasks.inProgress + summary.tasks.open;
      if (workSessions > 0) {
        lines.push(`${workSessions} work sessions in progress`);
      }

      // Add dashboard URL
      const dashboardUrl = `${process.env.APP_URL ?? "https://founderos.io"}/companies/${companyId}/dashboard`;
      lines.push(`${dashboardUrl}`);

      briefText = lines.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to compile brief";
      logger.error({ err, companyId }, `slack-digest: dashboard summary failed — ${msg}`);
      // Fall back to minimal brief
      briefText = `Morning Brief — ${companyRow.name ?? "Your company"}\n(Details unavailable at this time)`;
    }

    // Post to Slack
    const postResult = await client.postMessage(defaultChannelId, briefText);
    if (!postResult.ok) {
      const msg = postResult.error;
      logger.error(
        { integrationId, companyId, channelId: defaultChannelId },
        `slack-digest: postMessage failed — ${msg}`,
      );
      return { ok: false, error: msg };
    }

    // Log success
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "slack-digest",
      action: "slack.brief_delivered",
      entityType: "integration",
      entityId: integrationId,
      details: {
        channelId: defaultChannelId,
        ts: postResult.ts,
      },
    }).catch((err) => {
      logger.error(
        { err, integrationId },
        "slack-digest: failed to log activity",
      );
    });

    logger.info(
      { integrationId, companyId, channelId: defaultChannelId },
      "slack-digest: brief delivered successfully",
    );

    return {
      ok: true,
      channel: defaultChannelId,
      ts: postResult.ts,
    };
  } catch (err: unknown) {
    if (err instanceof SlackAuthError) {
      const msg = "Slack bot token is invalid or expired";
      logger.warn({ integrationId, companyId }, msg);
      return { ok: false, error: msg };
    }

    const msg = err instanceof Error ? err.message : "Unknown error during digest delivery";
    logger.error(
      { err, integrationId, companyId },
      "slack-digest: delivery failed",
    );
    return { ok: false, error: msg };
  }
}
