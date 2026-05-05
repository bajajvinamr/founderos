/**
 * linkedin-ingest.ts — LinkedIn read path (S2.4)
 *
 * Pulls post performance metrics and follower counts from LinkedIn via Composio.
 * Maps to normalized event rows for content attribution + reach tracking.
 *
 * Design:
 *   - Uses Composio v3 client (managed LinkedIn OAuth)
 *   - CRITICAL: threads `connectedAccountId` from workspace's Composio connection
 *     to prevent cross-org leaks (PR #30). Every runComposioTool call includes it.
 *   - Recurring: every 1 hour, fetch posts from last 30 days + daily follower snapshots
 *   - Dedup: dedupKey = `<post_id>:<snapshot_date>` for metrics snapshots
 *   - Rate limiting: exponential backoff (1s, 4s, 16s) on 429/503, then give up
 *
 * Composio LinkedIn tool slugs (discovered via composio.tools.list({ toolkits: ['linkedin'] })):
 *   - linkedin_get_posts: fetch recent posts for a LinkedIn profile
 *   - linkedin_get_post_metrics: fetch metrics (impressions, engagement) for a post
 *   - linkedin_get_followers: fetch follower count for a profile
 *
 * Events emitted:
 *   - post.metrics_snapshot (entity_type: 'post') — captures impressions, engagement at a point in time
 *   - profile.followers_snapshot (entity_type: 'profile') — daily follower count
 */

import type { Db } from "@founderos/db";
import { composioConnections } from "@founderos/db";
import { and, eq } from "drizzle-orm";
import { ingestEvent, type IngestEventInput } from "../event-ingest.js";
import { executeTool } from "../composio-client.js";
import { logger } from "../../middleware/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedInIngestInput {
  companyId: string;
  db: Db;
}

export interface LinkedInIngestResult {
  postsProcessed: number;
  followersProcessed: number;
  syncedAt: Date;
  nextSyncAt: Date;
}

interface LinkedInPost {
  id: string;
  text?: string;
  createdAt?: string;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  impressionCount?: number;
  [key: string]: unknown;
}

interface LinkedInProfile {
  followerCount?: number;
  [key: string]: unknown;
}

interface ComposioPostsResponse {
  ok: boolean;
  output?: {
    posts?: LinkedInPost[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ComposioPostMetricsResponse {
  ok: boolean;
  output?: {
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
    impressionCount?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ComposioFollowersResponse {
  ok: boolean;
  output?: LinkedInProfile;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backoff strategy for rate limiting
// ─────────────────────────────────────────────────────────────────────────────

const BACKOFF_MS = [1_000, 4_000, 16_000];

async function executeWithBackoff<T>(
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < BACKOFF_MS.length - 1) {
        const backoffMs = BACKOFF_MS[attempt];
        logger.debug(
          { backoffMs, attempt },
          "linkedin-ingest: rate limit detected, backing off",
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const POSTS_LOOKBACK_DAYS = 30;

/**
 * Ingest LinkedIn data (post metrics + follower count) for a given workspace/company.
 *
 * Flow:
 *  1. Fetch the workspace's active LinkedIn Composio connection
 *  2. Fetch recent posts (last 30 days)
 *  3. For each post, fetch metrics and emit post.metrics_snapshot event
 *  4. Fetch follower count and emit profile.followers_snapshot event
 *  5. Return counts and next sync time
 */
export async function linkedinIngestService(
  input: LinkedInIngestInput,
): Promise<LinkedInIngestResult> {
  const { companyId, db } = input;

  // ─── Step 1: Fetch workspace's LinkedIn connection ─────────────────────

  const connections = await db
    .select()
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.companyId, companyId),
        eq(composioConnections.appName, "linkedin"),
      ),
    )
    .limit(1);

  if (connections.length === 0) {
    logger.info({ companyId }, "linkedin-ingest: no active LinkedIn connection for workspace");
    return {
      postsProcessed: 0,
      followersProcessed: 0,
      syncedAt: new Date(),
      nextSyncAt: new Date(Date.now() + DEFAULT_SYNC_INTERVAL_MS),
    };
  }

  const conn = connections[0];
  const connectedAccountId = conn.composioConnectionId;
  const userId = conn.userId;

  let postsProcessed = 0;
  let followersProcessed = 0;

  // ─── Step 2: Fetch recent posts from LinkedIn ────────────────────────

  try {
    const postsResult = (await executeWithBackoff(async () =>
      executeTool({
        userId,
        toolName: "linkedin_get_posts",
        connectedAccountId,
        params: {
          limit: 50,
        },
      }),
    )) as ComposioPostsResponse;

    if (!postsResult.ok) {
      logger.error(
        { companyId, reason: postsResult },
        "linkedin-ingest: failed to fetch posts",
      );
    } else if (postsResult.output?.posts) {
      const posts: LinkedInPost[] = postsResult.output.posts;
      const now = new Date();
      const lookbackDate = new Date(now.getTime() - POSTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      for (const post of posts) {
        const postCreatedAt = post.createdAt ? new Date(post.createdAt) : now;

        // Skip posts older than 30 days
        if (postCreatedAt < lookbackDate) {
          continue;
        }

        // ─── Step 3: Fetch metrics for this post ──────────────────────

        let metrics: LinkedInPost | null = null;
        try {
          const metricsResult = (await executeWithBackoff(async () =>
            executeTool({
              userId,
              toolName: "linkedin_get_post_metrics",
              connectedAccountId,
              params: {
                postId: post.id,
              },
            }),
          )) as ComposioPostMetricsResponse;

          if (metricsResult.ok && metricsResult.output) {
            metrics = metricsResult.output as unknown as LinkedInPost;
          } else {
            logger.warn(
              { companyId, postId: post.id },
              "linkedin-ingest: failed to fetch post metrics",
            );
          }
        } catch (metricsErr) {
          logger.error(
            { err: metricsErr, companyId, postId: post.id },
            "linkedin-ingest: error fetching post metrics",
          );
        }

        // Emit event with metrics snapshot
        const snapshotDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
        const dedupKey = `${post.id}:${snapshotDate}`;

        const ingestPayload: IngestEventInput = {
          companyId,
          source: "linkedin",
          entityType: "post",
          eventName: "post.metrics_snapshot",
          dedupKey,
          occurredAt: now,
          payload: {
            postId: post.id,
            text: post.text,
            createdAt: post.createdAt,
            metrics: {
              impressionCount: metrics?.impressionCount ?? post.impressionCount ?? 0,
              likeCount: metrics?.likeCount ?? post.likeCount ?? 0,
              commentCount: metrics?.commentCount ?? post.commentCount ?? 0,
              shareCount: metrics?.shareCount ?? post.shareCount ?? 0,
            },
          },
        };

        try {
          await ingestEvent(ingestPayload);
          postsProcessed++;
        } catch (ingestErr) {
          logger.error(
            { err: ingestErr, companyId, postId: post.id },
            "linkedin-ingest: failed to ingest post event",
          );
          // Continue processing other posts on error
        }
      }

      logger.info({ companyId, postsProcessed }, "linkedin-ingest: posts synced");
    }
  } catch (err) {
    logger.error({ err, companyId }, "linkedin-ingest: failed to fetch posts");
    // Don't throw; continue to followers
  }

  // ─── Step 4: Fetch follower count ──────────────────────────────────

  try {
    const followersResult = (await executeWithBackoff(async () =>
      executeTool({
        userId,
        toolName: "linkedin_get_followers",
        connectedAccountId,
        params: {},
      }),
    )) as ComposioFollowersResponse;

    if (!followersResult.ok) {
      logger.error(
        { companyId, reason: followersResult },
        "linkedin-ingest: failed to fetch followers",
      );
    } else if (followersResult.output?.followerCount !== undefined) {
      const followerCount = followersResult.output.followerCount;
      const now = new Date();
      const snapshotDate = now.toISOString().split("T")[0]; // YYYY-MM-DD

      const ingestPayload: IngestEventInput = {
        companyId,
        source: "linkedin",
        entityType: "profile",
        eventName: "profile.followers_snapshot",
        dedupKey: snapshotDate,
        occurredAt: now,
        payload: {
          followerCount,
        },
      };

      try {
        await ingestEvent(ingestPayload);
        followersProcessed = 1;
        logger.info({ companyId, followerCount }, "linkedin-ingest: followers synced");
      } catch (ingestErr) {
        logger.error(
          { err: ingestErr, companyId },
          "linkedin-ingest: failed to ingest followers event",
        );
      }
    }
  } catch (err) {
    logger.error({ err, companyId }, "linkedin-ingest: failed to fetch followers");
  }

  return {
    postsProcessed,
    followersProcessed,
    syncedAt: new Date(),
    nextSyncAt: new Date(Date.now() + DEFAULT_SYNC_INTERVAL_MS),
  };
}
