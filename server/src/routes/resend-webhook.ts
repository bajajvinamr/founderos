/**
 * resend-webhook.ts — Receiver for Resend email lifecycle events (W0.2c).
 *
 * Council 2026-05-05 W0.2 BLOCK fix companion. Closes the buyer-trust gap
 * surfaced by the council: workflow_run actions were marked "completed" the
 * moment Resend ACCEPTED the email, but accept != deliver. A typo'd address
 * or a bounce would still report "completed" to the founder UI.
 *
 * After this route lands:
 *   action.status moves through the full lifecycle by `providerMessageId`:
 *     pending  → completed (transport accepted, "queued")
 *              → completed + payload.delivered=true (email.delivered)
 *              → failed     + payload.bounced=true   (email.bounced)
 *              → completed + payload.complained=true (email.complained)
 *
 * ## Mount path
 * `POST /api/webhooks/resend` — unauthenticated, signed via Svix headers.
 *
 * ## Signature
 * Resend uses Svix. Headers `svix-id`, `svix-timestamp`, `svix-signature`
 * + `RESEND_WEBHOOK_SECRET` (whsec_...). Verification lives in
 * `services/transports/resend-webhook-verify.ts`. We rely on the rawBody
 * Buffer captured by the global express.json verify hook in app.ts:166.
 *
 * ## Concurrency
 * Two events for the same workflow_run can land concurrently (e.g., delivered
 * for action A while bounced for action B in a 3-action onboarding sequence).
 * The handler uses `db.transaction` + `SELECT ... FOR UPDATE` on the run row
 * to serialize the JSONB read-modify-write of the actions array.
 *
 * ## Always 200
 * Return 200 to Resend on every signature-verified event, even when our DB
 * update fails — Resend's retry policy is exponential and aggressive; we
 * don't want to multiply transient internal errors into webhook storms.
 * The error path logs at `error` so oncall sees it via Sentry; signature
 * failures return 401 to surface misconfig fast.
 *
 * ## What we don't do (yet)
 *  - Open / click engagement events: not needed for W0.2c trust closure;
 *    layered in later (S5 finance attribution would consume them).
 *  - Webhook idempotency at the DB layer: Svix delivers at-least-once but
 *    repeating an "email.delivered" stamp on an already-delivered action
 *    is idempotent (same fields overwritten with same values). Bounce
 *    after delivered is unusual but allowed — the bounced flag wins
 *    semantically because it's the more recent signal.
 */

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { workflowRuns, type WorkflowAction, type WorkflowRunStatus } from "@founderos/db";
import { logger } from "../middleware/logger.js";
import { verifySvixSignature } from "../services/transports/resend-webhook-verify.js";

// ── Resend webhook event shapes ─────────────────────────────────────────────

interface ResendTag {
  name: string;
  value: string;
}

interface ResendEventBase {
  type: string;
  created_at?: string;
  data: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    tags?: ResendTag[];
    bounce?: { message?: string; subType?: string };
  };
}

// ── Status transition helpers ───────────────────────────────────────────────

type ActionUpdate = (action: WorkflowAction) => WorkflowAction;

/**
 * eventToActionUpdate — map a Resend event type to the per-action mutation.
 *
 * Returns null for event types we choose to ignore (e.g., engagement events
 * outside W0.2c scope). The handler short-circuits on null with a 200 ack.
 */
function eventToActionUpdate(event: ResendEventBase): ActionUpdate | null {
  const at = event.created_at ?? new Date().toISOString();
  const reason = event.data.bounce?.message;

  switch (event.type) {
    case "email.delivered":
      return (action) => ({
        ...action,
        status: "completed" as const,
        executedAt: action.executedAt ?? at,
        payload: { ...action.payload, delivered: true, deliveredAt: at },
      });

    case "email.bounced":
      return (action) => ({
        ...action,
        status: "failed" as const,
        error: reason ?? action.error ?? "bounced",
        executedAt: action.executedAt ?? at,
        payload: {
          ...action.payload,
          bounced: true,
          bouncedAt: at,
          ...(reason ? { bounceReason: reason } : {}),
        },
      });

    case "email.complained":
      // Spam complaint isn't a delivery failure but is an audit-relevant
      // signal — keep status, mark the payload so the UI / oncall can surface.
      return (action) => ({
        ...action,
        payload: { ...action.payload, complained: true, complainedAt: at },
      });

    case "email.failed":
      // Resend "failed" is a hard send-side failure (auth, blocked domain).
      return (action) => ({
        ...action,
        status: "failed" as const,
        error: reason ?? "resend reported failed",
        executedAt: action.executedAt ?? at,
        payload: { ...action.payload, providerFailed: true, providerFailedAt: at },
      });

    case "email.delivery_delayed":
      // Soft signal; keep status, just stamp.
      return (action) => ({
        ...action,
        payload: { ...action.payload, delayedAt: at },
      });

    case "email.opened":
    case "email.clicked":
    case "email.sent":
      // Outside W0.2c scope; acknowledge silently.
      return null;

    default:
      return null;
  }
}

/**
 * deriveRunStatusFromActions — recompute the run-level terminal state.
 *
 * Mirrors the logic in onboarding-emails.ts and upsell.ts: any failed action
 * → run.status = "failed"; otherwise leave unchanged. Don't promote to
 * "completed" here — that's the template's responsibility on first execution.
 */
function deriveRunStatusFromActions(
  actions: WorkflowAction[],
  current: WorkflowRunStatus,
): WorkflowRunStatus {
  if (current === "failed") return current; // already terminal-failed
  const anyFailed = actions.some((a) => a.status === "failed");
  if (anyFailed) return "failed";
  return current;
}

// ── Route ───────────────────────────────────────────────────────────────────

export function resendWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/api/webhooks/resend", async (req: Request, res: Response) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      // Fail closed — operator hasn't configured the secret. Don't accept
      // unsigned events. 503 surfaces the misconfig; Resend will retry.
      logger.error("resend webhook unconfigured: RESEND_WEBHOOK_SECRET missing");
      res.status(503).json({ error: "webhook not configured" });
      return;
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      logger.error("resend webhook missing rawBody — verify hook not active");
      res.status(500).json({ error: "raw body not available" });
      return;
    }

    const verify = verifySvixSignature(
      secret,
      req.header("svix-id"),
      req.header("svix-timestamp"),
      req.header("svix-signature"),
      rawBody,
    );

    if (!verify.ok) {
      logger.warn(
        { reason: verify.reason, svixId: req.header("svix-id") },
        "resend webhook signature rejected",
      );
      res.status(401).json({ error: "invalid signature", reason: verify.reason });
      return;
    }

    // Parsed body is already in req.body (express.json ran post-verify).
    const event = req.body as ResendEventBase | undefined;
    if (!event || typeof event.type !== "string" || !event.data) {
      logger.warn({ event }, "resend webhook payload malformed");
      res.status(400).json({ error: "malformed payload" });
      return;
    }

    const emailId = event.data.email_id;
    const tags = event.data.tags ?? [];
    const workflowRunId = tags.find((t) => t.name === "workflow_run_id")?.value;

    // No workflow_run_id tag → this is either a probe / a non-FounderOS email
    // / a manual send via the dashboard. Acknowledge and move on.
    if (!workflowRunId || !emailId) {
      logger.info(
        { type: event.type, emailId, hasRunIdTag: Boolean(workflowRunId) },
        "resend webhook event with no workflow_run_id tag — acknowledging",
      );
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const update = eventToActionUpdate(event);
    if (!update) {
      // Engagement event we don't track yet, or unknown type — ack silently.
      res.status(200).json({ ok: true, untracked: event.type });
      return;
    }

    try {
      // Transaction + row lock to serialize concurrent updates against the
      // same run's JSONB actions[]. Without the FOR UPDATE the read-modify-
      // write on actions becomes lossy under concurrent webhook storms.
      await db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, workflowRunId))
          .for("update");

        if (!run) {
          logger.warn({ workflowRunId, type: event.type }, "resend webhook: workflow_run not found");
          return;
        }

        const actions = (run.actions ?? []) as WorkflowAction[];
        const targetIdx = actions.findIndex(
          (a) =>
            (a.payload as { providerMessageId?: string } | null)?.providerMessageId === emailId,
        );

        if (targetIdx === -1) {
          logger.warn(
            { workflowRunId, emailId, type: event.type },
            "resend webhook: no action matches providerMessageId",
          );
          return;
        }

        const updatedAction = update(actions[targetIdx]!);
        const nextActions = [...actions];
        nextActions[targetIdx] = updatedAction;

        const nextStatus = deriveRunStatusFromActions(nextActions, run.status);
        const completedAt = nextStatus === "failed" ? new Date() : undefined;

        await tx
          .update(workflowRuns)
          .set({
            actions: nextActions,
            status: nextStatus,
            ...(completedAt ? { completedAt } : {}),
          })
          .where(eq(workflowRuns.id, workflowRunId));

        logger.info(
          {
            workflowRunId,
            emailId,
            type: event.type,
            actionType: updatedAction.type,
            actionStatus: updatedAction.status,
            runStatus: nextStatus,
          },
          "resend webhook: action updated",
        );
      });
    } catch (err) {
      // Log and 200 — see file header on retry policy. The signature is good;
      // an internal error shouldn't trigger Resend's exponential retry.
      logger.error({ err, workflowRunId, type: event.type }, "resend webhook: db update failed");
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
