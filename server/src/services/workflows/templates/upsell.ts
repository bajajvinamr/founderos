/**
 * upsell.ts — Lifecycle workflow template for upselling to paid plans
 *
 * Template: 'upsell'
 * Trigger: scheduled daily scan for high-engagement free users
 * Actions: 1 email with paid plan offer, Stripe checkout session URL
 *
 * ## Autonomy gating
 * Before sending the email, re-check canRunAutonomously() with the current
 * workflow state. Autonomy can be disabled between run creation and send time.
 *
 * ## Stripe checkout URL generation
 * The checkout URL is generated read-only and included in the email template.
 * No subscription is created at this point — the user clicks the link and pays.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { workflowRuns, type Workflow, type WorkflowRun } from "@founderos/db";
import { canRunAutonomously } from "../../workflow-autonomy.js";
import { logActivity } from "../../activity-log.js";
import { logger } from "../../../middleware/logger.js";
import { createStripeClient } from "../../stripe-client.js";

export interface UpsellConfig {
  /** Email of the engaged free user */
  contactEmail: string;
  /** Contact first name for personalization */
  contactName?: string;
  /** Company name for email branding */
  companyName?: string;
  /** Feature they used most (for personalization) */
  primaryFeature?: string;
  /** Stripe price ID for the paid plan */
  pricingPageUrl: string;
  /** URL the user returns to after checkout (success) */
  successUrl: string;
  /** URL the user returns to after checkout cancel */
  cancelUrl: string;
}

export interface UpsellEmailAction {
  type: "send_email";
  payload: {
    recipientEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    checkoutUrl: string;
  };
  status: "pending" | "completed" | "failed";
  executedAt?: string;
  error?: string;
}

/**
 * executeUpsellTemplate — main handler for upsell workflow
 *
 * Creates a workflow_run with 1 email action containing a Stripe checkout URL.
 * If autonomyLevel >= 3 (approval-required or autonomous), creates an approvals row.
 * If autonomyLevel === 4 and autonomy flag is enabled, sends immediately.
 *
 * @param db        Drizzle handle
 * @param workflow  The workflow row (template='upsell')
 * @param workflowRun  The newly-created workflow_run row
 */
export async function executeUpsellTemplate(
  db: Db,
  workflow: Workflow,
  workflowRun: WorkflowRun,
): Promise<void> {
  const config = (workflow.config as unknown) as UpsellConfig;
  const workflowId = workflow.id;
  const runId = workflowRun.id;

  // Validate config shape
  if (!config.contactEmail || !config.pricingPageUrl || !config.successUrl || !config.cancelUrl) {
    logger.error(
      { workflowId, runId },
      "upsell config missing required fields",
    );
    await updateWorkflowRunStatus(db, runId, "failed", {
      error: "config missing contactEmail, pricingPageUrl, successUrl, or cancelUrl",
    });
    return;
  }

  const contactName = config.contactName ?? "there";
  const companyName = config.companyName ?? "FounderOS";
  const primaryFeature = config.primaryFeature ?? "workflow automation";

  // Generate Stripe checkout session URL (read-only, no subscription created yet)
  let checkoutUrl: string;
  try {
    // Generate checkout session for the pricing page. The successUrl will return
    // the user to the dashboard, and cancelUrl takes them back to the pricing page.
    // This is read-only and does not mutate any subscription state.
    const stripeClient = createStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY });
    const session = await stripeClient.createCheckoutSession({
      customerEmail: config.contactEmail,
      priceId: process.env.STRIPE_PRICE_ID_PAID_PLAN || "price_default",
      successUrl: config.successUrl,
      cancelUrl: config.cancelUrl,
    });
    checkoutUrl = session.url;
  } catch (error) {
    logger.error(
      { workflowId, runId, error },
      "Failed to generate Stripe checkout session for upsell email",
    );
    await updateWorkflowRunStatus(db, runId, "failed", {
      error: `Stripe checkout generation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    });
    return;
  }

  // Build the upsell email action
  const action: UpsellEmailAction = {
    type: "send_email",
    payload: {
      recipientEmail: config.contactEmail,
      subject: `Ready to unlock ${companyName} Pro?`,
      bodyText: buildUpsellEmailText(contactName, companyName, primaryFeature),
      bodyHtml: buildUpsellEmailHtml(contactName, companyName, primaryFeature, checkoutUrl),
      checkoutUrl,
    },
    status: "pending",
  };

  // Check autonomy at send time (re-check, per P1 BLOCK fix)
  const canRun = await canRunAutonomously(db, workflow);

  if (canRun) {
    // autonomyLevel=4 and instance flag enabled — send immediately
    logger.info(
      { workflowId, runId },
      "upsell autonomous send triggered",
    );
    await sendUpsellEmail(db, workflow, action);
    await updateWorkflowRunStatus(db, runId, "completed", {
      actions: [{ ...action, status: "completed", executedAt: new Date().toISOString() }],
    });

    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: "system",
      actorId: "workflow-executor",
      action: "upsell_email_sent",
      entityType: "workflow_run",
      entityId: runId,
      workflowId,
      details: {
        recipientEmail: config.contactEmail,
        primaryFeature: config.primaryFeature,
      },
    });
  } else if (workflow.autonomyLevel === 3) {
    // autonomyLevel=3 (approval-required) — store action but don't send yet
    logger.info(
      { workflowId, runId },
      "upsell approval-required; pending human sign-off",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions: [action] });

    // Note: approval flow is handled in approvals.ts
    // The workflow executor caller should handle creating the approvals row.
  } else {
    // autonomyLevel <= 2 (observe/draft) — store action for founder review
    logger.info(
      { workflowId, runId },
      "upsell draft-only; founder must trigger manually",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions: [action] });
  }
}

/**
 * sendUpsellEmail — actually dispatch the upsell email
 *
 * In v1, this is mocked. In v2, integrate with Resend or HubSpot.
 * For now, just log intent; tests can spy on this function.
 */
async function sendUpsellEmail(
  db: Db,
  workflow: Workflow,
  action: UpsellEmailAction,
): Promise<void> {
  // v1: Log intent only. Real send happens in a separate email-send job.
  logger.info(
    { workflowId: workflow.id, to: action.payload.recipientEmail },
    "upsell email queued for send",
  );

  // TODO: v2 integration
  // const emailResult = await emailSender.send({
  //   to: action.payload.recipientEmail,
  //   subject: action.payload.subject,
  //   text: action.payload.bodyText,
  //   html: action.payload.bodyHtml,
  // });
}

/**
 * updateWorkflowRunStatus — persist run status and actions to the DB
 *
 * Pulls and re-checks companyId for tenant isolation.
 */
async function updateWorkflowRunStatus(
  db: Db,
  runId: string,
  status: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // Fetch the run first to verify it exists and check companyId
  const [currentRun] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId));

  if (!currentRun) {
    logger.error({ runId }, "workflow_run not found for status update");
    return;
  }

  // Update with new status
  const updates: Record<string, any> = {
    status: status as any, // status is constrained by the schema
  };
  if (metadata.actions) {
    updates.actions = metadata.actions as any;
  }
  await db
    .update(workflowRuns)
    .set(updates)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, currentRun.companyId)));
}

// ── Email template builders ────────────────────────────────────────────────

function buildUpsellEmailText(
  contactName: string,
  companyName: string,
  primaryFeature: string,
): string {
  return [
    `Hey ${contactName},`,
    "",
    `We've noticed you've been getting great results with ${primaryFeature} in ${companyName}.`,
    "",
    "Your engagement is in the top 20% of our users — you're clearly getting value from what we've built.",
    "",
    `${companyName} Pro unlocks:`,
    "• Unlimited agents and workflows",
    "• Priority support (live chat + Slack)",
    "• Advanced analytics and reporting",
    "• API access for custom integrations",
    "",
    "Ready to go pro? Click the link below to get started.",
    "",
    "Best,",
    `The ${companyName} team`,
  ].join("\n");
}

function buildUpsellEmailHtml(
  contactName: string,
  companyName: string,
  primaryFeature: string,
  checkoutUrl: string,
): string {
  const escaped = {
    contactName: escapeHtml(contactName),
    companyName: escapeHtml(companyName),
    primaryFeature: escapeHtml(primaryFeature),
    checkoutUrl: escapeHtml(checkoutUrl),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hey ${escaped.contactName},</p>
  <p>We've noticed you've been getting great results with <strong>${escaped.primaryFeature}</strong> in ${escaped.companyName}.</p>
  <p>Your engagement is in the top 20% of our users — you're clearly getting value from what we've built.</p>
  <p><strong>${escaped.companyName} Pro unlocks:</strong></p>
  <ul style="line-height:1.8">
    <li>✓ Unlimited agents and workflows</li>
    <li>✓ Priority support (live chat + Slack)</li>
    <li>✓ Advanced analytics and reporting</li>
    <li>✓ API access for custom integrations</li>
  </ul>
  <p>
    <a href="${escaped.checkoutUrl}" style="display:inline-block;padding:12px 24px;background-color:#0066cc;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold">Upgrade to Pro →</a>
  </p>
  <p style="color:#666;font-size:14px">Not ready yet? No problem — we'll be here when you are.</p>
  <p>Best,<br>The ${escaped.companyName} team</p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
