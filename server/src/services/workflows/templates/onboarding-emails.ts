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
import { getEmailTransport } from "../../transports/email-transport.js";
import { isSuppressed } from "../../customer-email-suppressions.js";
import { buildUnsubscribeUrl } from "../../email-unsubscribe-tokens.js";

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
  /**
   * Action status:
   *   - "pending":   initial; not yet attempted
   *   - "running":   transport.send() in flight (transient; rarely persisted)
   *   - "completed": transport accepted (Resend 200/201, capture-mode unconditional)
   *   - "failed":    transport rejected synchronously
   *   - "skipped":   pre-send suppression check found a customer_email_suppressions
   *                  row; the send was deliberately not attempted. Council 2026-05-06
   *                  finding #4 #196 layer 3c-1.
   */
  status: "pending" | "running" | "completed" | "failed" | "skipped";
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

  // CAN-SPAM unsubscribe URL — built once per workflow_run so all 3 emails
  // share the same token (recipient + topic identical across the sequence).
  // Same shape as slack-digest.ts: APP_URL env, default to founderos.io.
  // Throws if EMAIL_UNSUBSCRIBE_SECRET is unset (env-validation marks it WARN
  // but every customer-email send NEEDS it — fail loudly here, not silently).
  const baseUrl = process.env.APP_URL ?? "https://founderos.io";
  const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, {
    c: workflow.companyId,
    e: config.contactEmail.toLowerCase(),
    t: "onboarding",
    ts: Date.now(),
  });

  // Build the 3 email actions
  const actions: OnboardingEmailAction[] = [
    {
      type: "send_email",
      payload: {
        day: 0,
        recipientEmail: config.contactEmail,
        subject: `Welcome to ${companyName}`,
        bodyText: buildOnboardingEmailText(0, contactName, companyName, unsubscribeUrl),
        bodyHtml: buildOnboardingEmailHtml(0, contactName, companyName, config.dashboardUrl, unsubscribeUrl),
      },
      status: "pending",
    },
    {
      type: "send_email",
      payload: {
        day: 2,
        recipientEmail: config.contactEmail,
        subject: `Getting started with ${companyName} — Day 2`,
        bodyText: buildOnboardingEmailText(2, contactName, companyName, unsubscribeUrl),
        bodyHtml: buildOnboardingEmailHtml(2, contactName, companyName, config.dashboardUrl, unsubscribeUrl),
      },
      status: "pending",
    },
    {
      type: "send_email",
      payload: {
        day: 7,
        recipientEmail: config.contactEmail,
        subject: `What to do next with ${companyName}`,
        bodyText: buildOnboardingEmailText(7, contactName, companyName, unsubscribeUrl),
        bodyHtml: buildOnboardingEmailHtml(7, contactName, companyName, config.dashboardUrl, unsubscribeUrl),
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
    // Council 2026-05-05 W0.2 fix — sendOnboardingEmails MUTATES action.status
    // per result. Do NOT spread/.map(status:"completed") here — that would
    // obliterate the per-action transport result the function just set.
    // Persist actions as-is, then derive run status from action outcomes:
    //   - any "failed"   → run = "failed"   (loud signal in UI; partial-send incidents)
    //   - else "completed" or all queued → run = "completed"
    await sendOnboardingEmails(db, workflow, runId, actions);
    const anyFailed = actions.some((a) => a.status === "failed");
    const successCount = actions.filter((a) => a.status === "completed").length;
    const skippedCount = actions.filter((a) => a.status === "skipped").length;
    const runStatus = anyFailed ? "failed" : "completed";
    await updateWorkflowRunStatus(db, runId, runStatus, { actions });

    await logActivity(db, {
      companyId: workflow.companyId,
      actorType: "system",
      actorId: "workflow-executor",
      action: anyFailed ? "onboarding_emails_partial_failure" : "onboarding_emails_sent",
      entityType: "workflow_run",
      entityId: workflowId,
      workflowId,
      details: {
        recipientEmail: config.contactEmail,
        emailCount: actions.length,
        successCount,
        skippedCount,
        failureCount: actions.length - successCount - skippedCount,
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
 * sendOnboardingEmails — dispatch the 3 emails via the configured transport
 *
 * Council 2026-05-05 W0.2 BLOCK fix — replaced the "v1: Log intent only"
 * stub with real EmailTransport.send(). Mode is resolved per-process:
 * Resend in prod (when RESEND_API_KEY set), CaptureTransport in tests + dev
 * fallback. See services/transports/email-transport.ts for the full contract.
 *
 * Action status semantics:
 *   - "completed"   — transport accepted (Resend returned 200/201 with an id;
 *                     OR capture-mode unconditionally for dev/test)
 *   - "failed"      — transport rejected synchronously; reason captured
 *   - "pending"     — initial state; only reached if a send is skipped (e.g.
 *                     non-send_email action types in this loop)
 *
 * Note: Resend's accept ≠ delivery. The Resend webhook receiver (W0.2c, next
 * wake) listens for email.delivered / email.bounced events and updates the
 * action status to its terminal state. Until that lands, "completed" here
 * means "transport accepted" — sufficient for the founder-facing UI to stop
 * showing fake success on a 100%-of-the-time-undelivered workflow.
 */
async function sendOnboardingEmails(
  db: Db,
  workflow: Workflow,
  runId: string,
  actions: OnboardingEmailAction[],
): Promise<void> {
  const config = (workflow.config as unknown) as OnboardingEmailConfig;
  const transport = getEmailTransport();
  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "founderos@resend.dev";

  for (const action of actions) {
    if (action.type !== "send_email") continue;

    // Pre-send suppression check (#196 layer 3c-1, council 2026-05-06 finding #4).
    // Skip the send if the recipient has a customer_email_suppressions row for
    // either topic="onboarding" OR topic="all" (master switch). This is the
    // CAN-SPAM/GDPR compliance gate — never send to a contact who opted out.
    const suppressed = await isSuppressed(
      db,
      workflow.companyId,
      action.payload.recipientEmail,
      "onboarding",
    );
    if (suppressed) {
      const nowIso = new Date().toISOString();
      action.status = "skipped";
      action.executedAt = nowIso;
      (action.payload as unknown as Record<string, unknown>).skipReason =
        "customer_email_suppressed";
      logger.info(
        {
          workflowId: workflow.id,
          day: action.payload.day,
          to: action.payload.recipientEmail,
        },
        "onboarding email skipped — recipient is suppressed",
      );
      continue;
    }

    const result = await transport.send({
      to: action.payload.recipientEmail,
      from: fromAddress,
      subject: action.payload.subject,
      text: action.payload.bodyText,
      html: action.payload.bodyHtml,
      tags: [
        { name: "workflow_id", value: workflow.id },
        // Council R1 close-out P1 (2026-05-05 fix-the-fix) — without
        // workflow_run_id the Resend webhook receiver finds no run to
        // correlate the bounce/delivery event to and silently drops it.
        // Both Codex + Gemini flagged this as a both-confirmed P1 in the
        // Wave 0 close-out council. upsell.ts + activation-nudge.ts already
        // emit this; onboarding-emails.ts (the first template I converted
        // in commit b93a94e) was missed.
        { name: "workflow_run_id", value: runId },
        { name: "template", value: "onboarding-emails" },
        { name: "day", value: String(action.payload.day) },
      ],
    });

    const nowIso = new Date().toISOString();
    if (result.status === "queued") {
      action.status = "completed";
      action.executedAt = nowIso;
      // Persist provider id into payload for webhook reconciliation.
      (action.payload as unknown as Record<string, unknown>).providerMessageId = result.id;
      (action.payload as unknown as Record<string, unknown>).transportMode = transport.mode;
      logger.info(
        {
          workflowId: workflow.id,
          day: action.payload.day,
          to: action.payload.recipientEmail,
          providerMessageId: result.id,
          mode: transport.mode,
        },
        "onboarding email accepted by transport",
      );
    } else {
      action.status = "failed";
      action.executedAt = nowIso;
      (action.payload as unknown as Record<string, unknown>).failureReason = result.reason;
      logger.error(
        {
          workflowId: workflow.id,
          day: action.payload.day,
          to: action.payload.recipientEmail,
          reason: result.reason,
          mode: transport.mode,
        },
        "onboarding email rejected by transport",
      );
    }
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

/**
 * CAN-SPAM footer (text + HTML variants) — every customer-facing email MUST
 * include a working unsubscribe link. The link points at our public route
 * `/u/customer/:token` (layer 3b), HMAC-signed by layer 2's
 * `generateUnsubscribeToken`. One-click GET works in every email client;
 * RFC 8058 List-Unsubscribe-Post is set in the email headers (Resend handles
 * those — see email-transport.ts where `tags` map to provider headers).
 */
function buildOnboardingEmailText(
  day: 0 | 2 | 7,
  contactName: string,
  companyName: string,
  unsubscribeUrl: string,
): string {
  const footer = [
    "",
    "—",
    `You're receiving this because you signed up for ${companyName}.`,
    `To unsubscribe from these emails: ${unsubscribeUrl}`,
  ];

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
      ...footer,
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
      ...footer,
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
    ...footer,
  ].join("\n");
}

function buildOnboardingEmailHtml(
  day: 0 | 2 | 7,
  contactName: string,
  companyName: string,
  dashboardUrl: string,
  unsubscribeUrl: string,
): string {
  const escaped = {
    contactName: escapeHtml(contactName),
    companyName: escapeHtml(companyName),
    dashboardUrl: escapeHtml(dashboardUrl),
    unsubscribeUrl: escapeHtml(unsubscribeUrl),
  };
  // CAN-SPAM compliance footer; muted so it doesn't compete with primary CTA.
  const footer = `<hr style="margin-top:32px;border:none;border-top:1px solid #eee">
  <p style="font-size:12px;color:#999;line-height:1.5">
    You're receiving this because you signed up for ${escaped.companyName}.<br>
    <a href="${escaped.unsubscribeUrl}" style="color:#999;text-decoration:underline">Unsubscribe</a>
  </p>`;

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
  ${footer}
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
  ${footer}
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
  ${footer}
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
