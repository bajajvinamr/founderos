import { Queue, Worker, QueueEvents, UnrecoverableError } from "bullmq";
import { createClient } from "redis";
import { logger } from "../middleware/logger.js";

// Connection to Redis (shared across all queues)
let redisClient: ReturnType<typeof createClient> | null = null;

function getRedisConnection() {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = createClient({ url: redisUrl });
    redisClient.on("error", (err) => logger.error({ err }, "Redis client error"));
    redisClient.on("connect", () => logger.info("Redis client connected"));
  }
  return redisClient;
}

// Retry config for integration sync queues
const INGEST_QUEUE_RETRY_CONFIG = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 30_000, // 30 seconds initial delay
  },
};

// Queue definitions with names and configurations
export const QUEUE_NAMES = {
  EVENTS_DERIVE: "events.derive",
  EVENTS_DLQ: "events.dlq",
  STRIPE_INGEST: "stripe.ingest",
  POSTHOG_INGEST: "posthog.ingest",
  LINKEDIN_INGEST: "linkedin.ingest",
  HUBSPOT_INGEST: "hubspot.ingest",
  NOTION_INGEST: "notion.ingest",
  SLACK_INGEST: "slack.ingest",
} as const;

// Map of ingest queues for easier iteration
const INGEST_QUEUES = [
  QUEUE_NAMES.EVENTS_DERIVE,
  QUEUE_NAMES.STRIPE_INGEST,
  QUEUE_NAMES.POSTHOG_INGEST,
  QUEUE_NAMES.LINKEDIN_INGEST,
  QUEUE_NAMES.HUBSPOT_INGEST,
  QUEUE_NAMES.NOTION_INGEST,
  QUEUE_NAMES.SLACK_INGEST,
] as const;

// Cache for queue instances
const queueCache = new Map<string, Queue>();

/**
 * Get or create a queue instance with standard retry config for ingest queues.
 * DLQ queue is created without retry config since failed jobs won't retry.
 */
export function getQueue(queueName: string): Queue {
  if (queueCache.has(queueName)) {
    return queueCache.get(queueName)!;
  }

  const isIngestQueue = INGEST_QUEUES.includes(queueName as any);
  const isDlqQueue = queueName === QUEUE_NAMES.EVENTS_DLQ;

  const queue = new Queue(queueName, {
    connection: getRedisConnection() as any,
    defaultJobOptions: isIngestQueue
      ? {
          ...INGEST_QUEUE_RETRY_CONFIG,
          removeOnComplete: true, // Keep queue lean
          removeOnFail: false, // Keep failed jobs for DLQ processing
        }
      : isDlqQueue
        ? {
            removeOnComplete: false, // Keep DLQ entries until manually cleared
            removeOnFail: false,
          }
        : {},
  });

  queueCache.set(queueName, queue);
  return queue;
}

/**
 * Set up failed event listener on an ingest queue to move jobs to DLQ.
 * Call this once per ingest queue during initialization.
 */
export function setupDlqListener(queueName: string) {
  if (!INGEST_QUEUES.includes(queueName as any)) {
    logger.warn({ queueName }, "setupDlqListener: queue is not an ingest queue, skipping DLQ setup");
    return;
  }

  const queue = getQueue(queueName);
  const events = new QueueEvents(queueName, {
    connection: getRedisConnection() as any,
  });

  // Listen for failed jobs and move them to DLQ
  events.on("failed", async (jobData: { jobId?: string; err?: Error } | string, err?: unknown) => {
    const jobId = typeof jobData === "string" ? jobData : jobData.jobId;
    const error = typeof jobData === "string" ? err : jobData.err;

    if (!jobId) {
      logger.warn({ queueName }, "DLQ listener: job id missing from failed event");
      return;
    }

    try {
      const job = await queue.getJob(jobId);
      if (!job) {
        logger.warn({ queueName, jobId }, "DLQ listener: failed job not found");
        return;
      }

      // BullMQ internally tracks attempts, so we check the job's internal state
      // If attempt count reached max, move to DLQ
      const maxAttempts = job.opts.attempts || INGEST_QUEUE_RETRY_CONFIG.attempts;
      if (job.attemptsMade >= maxAttempts) {
        const dlqQueue = getQueue(QUEUE_NAMES.EVENTS_DLQ);
        const errorMessage = error instanceof Error ? error.message : String(error) || job.failedReason || "Unknown error";

        await dlqQueue.add(
          "dlq-entry",
          {
            originalJobId: jobId,
            originalQueue: queueName,
            failedAt: new Date(),
            failedReason: errorMessage,
            payload: job.data,
            attemptsMade: job.attemptsMade,
          },
          {
            attempts: 1, // DLQ entries don't retry
          },
        );

        logger.info(
          { queueName, jobId, attemptsMade: job.attemptsMade },
          "Job moved to DLQ after exhausting retries",
        );
      }
    } catch (dlqErr) {
      logger.error(
        { queueName, jobId, dlqErr },
        "Failed to move job to DLQ",
      );
    }
  });

  logger.info({ queueName }, "DLQ listener initialized");
}

/**
 * Initialize all ingest queue DLQ listeners.
 * Call once during server startup.
 */
export function initializeDlqListeners() {
  for (const queueName of INGEST_QUEUES) {
    setupDlqListener(queueName);
  }
}

/**
 * Gracefully close all queue connections.
 * Call during server shutdown.
 */
export async function closeQueues() {
  for (const queue of queueCache.values()) {
    await queue.close();
  }
  if (redisClient) {
    await redisClient.disconnect();
    redisClient = null;
  }
}
