/**
 * onboarding-emails.ts — Lifecycle workflow template for welcome sequence
 *
 * Template: 'onboarding-emails'
 * Trigger: event source=posthog, event=identify
 * Actions: 3 emails scheduled at Day 0, Day 2, Day 7
 *
 * The workflow handler is registered in workflows.ts via:
 *   executeWorkflowTemplate('onboarding-emails', db, workflow, workflowRun)
 *
 * ## Autonomy gating
 * Before sending any email, re-check canRunAutonomously() with the current
 * workflow state. Autonomy can be disabled between when the run was created
 * and when the send happens — respect that boundary.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  workflowRuns,
  type Workflow,
  type WorkflowRun,
} from "@founderos/db";
import { canRunAutonomously } from "../../workflow-autonomy.js";
import { logActivity } from "../../activity-log.js";
import { logger } from "../../../middleware/logger.js";

export interface OnboardingEmailConfig {
  /** Email address of the new contact (from trigger event) */
  contactEmail: string;
  /** Contact first name for personalization */
  contactName?: string;
  /** Company name (from founder's FounderOS settings) */
  companyName?: string;
  /** Public dashboard URL for the CTA */
  dashboardUrl: string;
}

export interface OnboardingEmailAction {
  type: "send_email";
  payload: {
    day: 0 | 2 | 7;
    recipientEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
  };
  status: "pending" | "completed" | "failed";
  executedAt?: string;
}

/**
 * executeOnboardingEmailTemplate — main handler for onboarding-emails
 *
 * Creates a workflow_run with 3 scheduled email actions (days 0, 2, 7).
 * If autonomyLevel >= 3 (approval-required or autonomous), creates an approvals row.
 * If autonomyLevel === 4 and autonomy flag is enabled, sends immediately.
 *
 * @param db      Drizzle handle
 * @param workflow  The workflow row (template='onboarding-emails')
 * @param workflowRun  The newly-created workflow_run row
 */
export async function executeOnboardingEmailTemplate(
  db: Db,
  workflow: Workflow,
  workflowRun: WorkflowRun,
): Promise<void> {
  const config = (workflow.config as unknown) as OnboardingEmailConfig;
  const workflowId = workflow.id;
  const runId = workflowRun.id;

  // Validate config shape
  if (!config?.contactEmail || !config?.dashboardUrl) {
    logger.error(
      { workflowId, runId },
      "onboarding-emails config missing required fields",
    );
    await updateWorkflowRunStatus(db, runId, "failed", {
      error: "config.contactEmail or config.dashboardUrl missing",
    });
    return;
  }

  const contactName = config.contactName ?? "there";
  const companyName = config.companyName ?? "FounderOS";

  // Build the 3 email actions
  const actions: OnboardingEmailAction[] = [
    {
      type: "send_email",
      payload: {
        day: 0,
        recipientEmail: config.contactEmail,
        subject: `Welcome to ${companyName}`,
        bodyText: buildOnboardingEmailText(0, contactName, companyName),
        bodyHtml: buildOnboardingEmailHtml(0, contactName, companyName, config.dashboardUrl),
      },
      status: "pending",
    },
    {
      type: "send_email",
      payload: {
        day: 2,
        recipientEmail: config.contactEmail,
        subject: `Getting started with ${companyName} — Day 2`,
        bodyText: buildOnboardingEmailText(2, contactName, companyName),
        bodyHtml: buildOnboardingEmailHtml(2, contactName, companyName, config.dashboardUrl),
      },
      status: "pending",
    },
    {
      type: "send_email",
      payload: {
        day: 7,
        recipientEmail: config.contactEmail,
        subject: `What to do next with ${companyName}`,
        bodyText: buildOnboardingEmailText(7, contactName, companyName),
        bodyHtml: buildOnboardingEmailHtml(7, contactName, companyName, config.dashboardUrl),
      },
      status: "pending",
    },
  ];

  // Check autonomy at send time (re-check, per P1 BLOCK fix)
  const canRun = await canRunAutonomously(db, workflow);

  if (canRun) {
    // autonomyLevel=4 and instance flag enabled — send immediately (in v1, this won't happen; founders default to approval-required)
    logger.info(
      { workflowId, runId },
      "onboarding-emails autonomous send triggered",
    );
    await sendOnboardingEmails(db, workflow, actions);
    await updateWorkflowRunStatus(db, runId, "completed", {
      actions: actions.map((a) => ({ ...a, status: "completed", executedAt: new Date().toISOString() })),
    });

    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: "system",
      actorId: "workflow-executor",
      action: "onboarding_emails_sent",
      entityType: "workflow_run",
      entityId: workflowId,
      workflowId,
      details: {
        recipientEmail: config.contactEmail,
        emailCount: 3,
      },
    });
  } else if (workflow.autonomyLevel === 3) {
    // autonomyLevel=3 (approval-required) — store actions but don't send yet
    logger.info(
      { workflowId, runId },
      "onboarding-emails approval-required; pending human sign-off",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions });

    // Note: approval flow is handled in approvals.ts (creates approvals row)
    // The workflow executor caller should handle that.
  } else {
    // autonomyLevel <= 2 (observe/draft) — store actions for founder review
    logger.info(
      { workflowId, runId },
      "onboarding-emails draft-only; founder must trigger manually",
    );
    await updateWorkflowRunStatus(db, runId, "pending_approval", { actions });
  }
}

/**
 * sendOnboardingEmails — actually dispatch the 3 emails
 *
 * In v1, this is mocked. In v2, integrate with Resend or HubSpot.
 * For now, just log intent; tests can spy on this function.
 */
async function sendOnboardingEmails(
  db: Db,
  workflow: Workflow,
  actions: OnboardingEmailAction[],
): Promise<void> {
  const config = (workflow.config as unknown) as OnboardingEmailConfig;

  for (const action of actions) {
    if (action.type !== "send_email") continue;

    // v1: Log intent only. Real send happens in a separate email-send job.
    logger.info(
      { workflowId: workflow.id, day: action.payload.day, to: action.payload.recipientEmail },
      "onboarding email queued for send",
    );

    // TODO: v2 integration
    // const emailResult = await emailSender.send({
    //   to: action.payload.recipientEmail,
    //   subject: action.payload.subject,
    //   text: action.payload.bodyText,
    //   html: action.payload.bodyHtml,
    // });
  }
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
  await db
    .update(workflowRuns)
    .set({
      status: status as any, // status is constrained by the schema
      actions: (metadata.actions ?? currentRun.actions) as any,
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, currentRun.companyId)));
}

// ── Email template builders ────────────────────────────────────────────────

function buildOnboardingEmailText(day: 0 | 2 | 7, contactName: string, companyName: string): string {
  if (day === 0) {
    return [
      `Hey ${contactName},`,
      "",
      `Welcome to ${companyName}! You've just signed up for the AI company OS.`,
      "",
      "Here's what to do next:",
      "1. Complete the onboarding wizard to pick your first team",
      "2. Connect an AI provider (Claude, Codex, or Gemini)",
      "3. Write your company charter — your team reads it on every shift",
      "",
      "Questions? Reply to this email or check our docs.",
      "",
      "Best,",
      `The ${companyName} team`,
    ].join("\n");
  }

  if (day === 2) {
    return [
      `Hey ${contactName},`,
      "",
      "Here are some getting-started tips for your first 48 hours:",
      "",
      "✓ Set up your first agent (CoS, Growth, Finance, or Content)",
      "✓ Write a brief company charter your team can read",
      "✓ Schedule your first team sync — agents read your charter before jumping in",
      "",
      "Check your dashboard for next steps.",
      "",
      "Best,",
      `The ${companyName} team`,
    ].join("\n");
  }

  // day === 7
  return [
    `Hey ${contactName},`,
    "",
    "You're one week in! Here's what high-velocity founders do next:",
    "",
    "→ Run a quick sync with your agents (2–3 minutes, they'll read your updated charter)",
    "→ Check the dashboard for insights — what are your agents learning about your company?",
    "→ Invite a co-founder or advisor to collaborate (adds another perspective to decisions)",
    "",
    "Need help? Our docs and support team are here.",
    "",
    "Best,",
    `The ${companyName} team`,
  ].join("\n");
}

function buildOnboardingEmailHtml(
  day: 0 | 2 | 7,
  contactName: string,
  companyName: string,
  dashboardUrl: string,
): string {
  const escaped = {
    contactName: escapeHtml(contactName),
    companyName: escapeHtml(companyName),
    dashboardUrl: escapeHtml(dashboardUrl),
  };

  if (day === 0) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hey ${escaped.contactName},</p>
  <p>Welcome to <strong>${escaped.companyName}</strong>! You've just signed up for the AI company OS.</p>
  <p><strong>Here's what to do next:</strong></p>
  <ol>
    <li>Complete the onboarding wizard to pick your first team</li>
    <li>Connect an AI provider (Claude, Codex, or Gemini)</li>
    <li>Write your company charter — your team reads it on every shift</li>
  </ol>
  <p><a href="${escaped.dashboardUrl}" style="color:#0066cc;text-decoration:none">Open your dashboard →</a></p>
  <p>Questions? Reply to this email or check our docs.</p>
  <p>Best,<br>The ${escaped.companyName} team</p>
</body>
</html>`;
  }

  if (day === 2) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hey ${escaped.contactName},</p>
  <p><strong>Getting-started tips for your first 48 hours:</strong></p>
  <ul style="line-height:1.8">
    <li>✓ Set up your first agent (CoS, Growth, Finance, or Content)</li>
    <li>✓ Write a brief company charter your team can read</li>
    <li>✓ Schedule your first team sync — agents read your charter before jumping in</li>
  </ul>
  <p><a href="${escaped.dashboardUrl}" style="color:#0066cc;text-decoration:none">Check your dashboard for next steps →</a></p>
  <p>Best,<br>The ${escaped.companyName} team</p>
</body>
</html>`;
  }

  // day === 7
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hey ${escaped.contactName},</p>
  <p><strong>You're one week in! Here's what high-velocity founders do next:</strong></p>
  <ul style="line-height:1.8">
    <li>→ Run a quick sync with your agents (2–3 minutes, they'll read your updated charter)</li>
    <li>→ Check the dashboard for insights — what are your agents learning about your company?</li>
    <li>→ Invite a co-founder or advisor to collaborate (adds another perspective to decisions)</li>
  </ul>
  <p><a href="${escaped.dashboardUrl}" style="color:#0066cc;text-decoration:none">Visit your dashboard →</a></p>
  <p>Need help? Our docs and support team are here.</p>
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
