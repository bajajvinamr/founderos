import { Router } from "express";
import { z } from "zod";
import { QUEUE_NAMES, getQueue } from "../lib/queues.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";

// DLQ entry schema for API responses
const dlqEntrySchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  failedAt: z.coerce.date(),
  failedReason: z.string(),
  payload: z.unknown(),
  attempts: z.number(),
});

type DlqEntry = z.infer<typeof dlqEntrySchema>;

export function integrationDlqRoutes() {
  const router = Router();

  /**
   * GET /api/integrations/dlq
   * List failed jobs in the dead-letter queue, paginated.
   * Query params: page (default 1), limit (default 50, max 100)
   */
  router.get("/dlq", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
      const offset = (page - 1) * limit;

      const dlqQueue = getQueue(QUEUE_NAMES.EVENTS_DLQ);

      // Get all jobs in the queue (BullMQ doesn't have built-in pagination for failed jobs)
      const allJobs = await dlqQueue.getJobs(["wait", "active", "paused", "failed"], 0, -1);

      // Sort by job id in descending order (newest first)
      const sorted = allJobs.sort((a, b) => {
        const aTime = a.finishedOn || a.processedOn || 0;
        const bTime = b.finishedOn || b.processedOn || 0;
        return bTime - aTime;
      });

      const paginated = sorted.slice(offset, offset + limit);

      const entries: DlqEntry[] = await Promise.all(
        paginated.map(async (job) => {
          const finishedTime = job.finishedOn || job.processedOn || Date.now();
          return {
            jobId: job.id || "unknown",
            queue: job.data?.originalQueue || QUEUE_NAMES.EVENTS_DLQ,
            failedAt: new Date(job.data?.failedAt || finishedTime),
            failedReason: job.data?.failedReason || job.failedReason || "Unknown error",
            payload: job.data?.payload || job.data || {},
            attempts: job.data?.attemptsMade || job.attemptsMade || 1,
          };
        }),
      );

      res.json({
        success: true,
        data: entries,
        meta: {
          total: sorted.length,
          page,
          limit,
          pages: Math.ceil(sorted.length / limit),
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to fetch DLQ entries");
      res.status(500).json({
        success: false,
        error: "Failed to fetch DLQ entries",
      });
    }
  });

  /**
   * POST /api/integrations/dlq/:jobId/retry
   * Move a failed job from DLQ back to its original queue for retry.
   */
  router.post("/dlq/:jobId/retry", async (req, res) => {
    const jobId = req.params.jobId as string;

    try {
      const dlqQueue = getQueue(QUEUE_NAMES.EVENTS_DLQ);
      const dlqJob = await dlqQueue.getJob(jobId);

      if (!dlqJob) {
        res.status(404).json({
          success: false,
          error: "Job not found in DLQ",
        });
        return;
      }

      const originalQueue = dlqJob.data?.originalQueue as string | undefined;
      const payload = dlqJob.data?.payload;

      if (!originalQueue) {
        logger.warn({ jobId }, "DLQ job missing original queue information");
        res.status(400).json({
          success: false,
          error: "Cannot determine original queue for retry",
        });
        return;
      }

      // Add job back to the original queue
      const parentQueue = getQueue(originalQueue);
      const newJob = await parentQueue.add(dlqJob.name || "retry", payload || {}, {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 30_000,
        },
      });

      // Remove from DLQ
      await dlqJob.remove();

      logger.info(
        { dlqJobId: jobId, originalQueue, newJobId: newJob.id },
        "Moved job from DLQ back to original queue",
      );

      res.json({
        success: true,
        message: "Job queued for retry",
        newJobId: newJob.id,
      });
    } catch (err) {
      logger.error({ jobId, err }, "Failed to retry DLQ job");
      res.status(500).json({
        success: false,
        error: "Failed to retry job",
      });
    }
  });

  return router;
}
