/**
 * churn-rescue-generator.ts — S4.8 demo ticket. Run-CREATION time builder.
 *
 * Council finding #4 (2026-05-06) discipline: generation MUST happen at
 * workflow_run CREATION time, not execution time. The founder approves a
 * frozen email body and that exact body ships — no re-roll-on-retry.
 *
 * This module is the create-time generator. It takes:
 *   - companyId (for tenant-scoped suppression filter via #195)
 *   - cohort: list of `(email, contactName?, cancellationCategory)` tuples
 *   - workflowConfig: { rescueUrl, couponCode, copyHint }
 *
 * And returns:
 *   - On success: { ok: true, actions: ChurnRescueAction[], counts }
 *   - On failure: { ok: false, reason } — caller refuses to create the run
 *
 * ## Why no LLM here (yet)
 *
 * For the S4.8 demo, deterministic copy is sufficient — the rescue email
 * is short, the coupon code is the persuasive lever, and re-running the
 * generator on the same input MUST produce byte-identical output (so the
 * idempotency-key contract from #192 holds).
 *
 * An LLM-personalized variant can replace this later via a strategy
 * parameter; the contract (input/output shapes) is stable so the swap is
 * mechanical.
 *
 * ## Why the cancellation category gates the copy
 *
 * Per #193, raw cancellation text is NEVER passed through to the prompt
 * or rendered into the email — only the closed enum category is. This
 * file therefore takes a `CancellationCategory` enum value (not raw text)
 * and dispatches on it.
 */

import type { Db } from "@founderos/db";
import {
  CANCELLATION_CATEGORIES,
  type CancellationCategory,
} from "../../cancellation-categories.js";
import {
  materializeRecipients,
  type MaterializationResult,
} from "../../recipient-materialization.js";
import type { ChurnRescueAction, ChurnRescueConfig } from "./churn-rescue.js";

// ── Public types ───────────────────────────────────────────────────────────

export interface ChurnRescueCandidate {
  email: string;
  contactName?: string;
  externalId?: string;
  /** Cancellation reason as an allowlisted enum (from #193). */
  cancellationCategory: CancellationCategory;
}

export type ChurnRescueGeneratorResult =
  | {
      ok: true;
      actions: ChurnRescueAction[];
      counts: {
        candidates: number;
        materialized: number;
        droppedInvalidEmail: number;
        droppedDuplicate: number;
        droppedSuppressed: number;
        droppedOverCap: number;
      };
    }
  | {
      ok: false;
      reason: "empty_input" | "all_dropped" | "exceeded_cap";
      details?: Record<string, unknown>;
    };

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * generateChurnRescueActions — produce the actions[] array for a churn-rescue run.
 *
 * Pipeline:
 *   1. materializeRecipients (#195) — validate, dedup, suppression-filter, cap
 *   2. For each retained recipient, render the email body using its
 *      cancellationCategory (PII allowlist via #193 — caller passes enum, never raw text)
 *   3. Return ChurnRescueAction[] ready to persist on workflow_run.actions
 */
export async function generateChurnRescueActions(
  db: Db,
  args: {
    companyId: string;
    candidates: ChurnRescueCandidate[];
    config: ChurnRescueConfig;
  },
): Promise<ChurnRescueGeneratorResult> {
  const { companyId, candidates, config } = args;

  // Step 1 — materialize the cohort (validates, dedups, suppression-filters, caps)
  const materialization: MaterializationResult = await materializeRecipients(
    db,
    {
      companyId,
      topic: "churn_rescue",
      candidates: candidates.map((c) => ({
        email: c.email,
        name: c.contactName,
        externalId: c.externalId,
        meta: { cancellationCategory: c.cancellationCategory },
      })),
    },
  );

  if (!materialization.ok) {
    return {
      ok: false,
      reason: materialization.reason,
      details: "counts" in materialization ? { counts: materialization.counts } : undefined,
    };
  }

  // Index incoming candidates by lowercased email so we can re-attach the
  // category that materialization erased to a generic `meta` blob.
  const categoryByEmail = new Map<string, CancellationCategory>();
  for (const c of candidates) {
    const key = c.email.trim().toLowerCase();
    if (!categoryByEmail.has(key)) {
      categoryByEmail.set(key, c.cancellationCategory);
    }
  }

  // Step 2 — render each retained recipient's email body
  const actions: ChurnRescueAction[] = materialization.recipients.map(
    (recipient) => {
      const category =
        categoryByEmail.get(recipient.email) ??
        ("other" as CancellationCategory);
      return buildAction(recipient.email, recipient.name, category, config);
    },
  );

  return {
    ok: true,
    actions,
    counts: {
      candidates: materialization.counts.received,
      materialized: materialization.counts.retained,
      droppedInvalidEmail: materialization.counts.invalidEmail,
      droppedDuplicate: materialization.counts.duplicate,
      droppedSuppressed: materialization.counts.suppressed,
      droppedOverCap: materialization.counts.overCap,
    },
  };
}

// ── Per-recipient renderer ─────────────────────────────────────────────────

function buildAction(
  recipientEmail: string,
  recipientName: string | undefined,
  category: CancellationCategory,
  config: ChurnRescueConfig,
): ChurnRescueAction {
  const couponCode = config.couponCode ?? "RESCUE25";
  const rescueUrl = config.rescueUrl ?? "https://founderos.io/billing";
  const ctaUrl = appendCouponParam(rescueUrl, couponCode);

  const subject = subjectForCategory(category);
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const reason = reasonAddressing(category);

  const bodyText = [
    greeting,
    "",
    `We're sorry to see you go. ${reason}`,
    "",
    `If you'd like to come back, here's a one-time ${couponCode} discount on your next 3 months:`,
    ctaUrl,
    "",
    "Either way — thank you for trying us out, and good luck with what's next.",
    "",
    "— The FounderOS team",
  ].join("\n");

  const bodyHtml = renderHtml({
    greeting,
    reason,
    couponCode,
    ctaUrl,
  });

  return {
    type: "send_email",
    payload: {
      recipientEmail,
      ...(recipientName ? { recipientName } : {}),
      subject,
      bodyText,
      bodyHtml,
    },
    status: "pending",
  };
}

// ── Category-aware copy helpers ────────────────────────────────────────────

/**
 * Per-category subject line. Each is short, non-pushy, and avoids language
 * that might feel manipulative ("DON'T LEAVE!" / "Last chance!" — banned).
 */
function subjectForCategory(category: CancellationCategory): string {
  switch (category) {
    case "pricing":
      return "Sorry to see you go — a one-time discount if you'd like to come back";
    case "missing_features":
      return "Sorry to see you go — what features were missing?";
    case "moving_to_competitor":
      return "Thanks for trying FounderOS — quick question on your way out";
    case "lack_of_usage":
      return "Sorry to see you go — would a discount help if you decide to come back?";
    case "technical_issues":
      return "Sorry to see you go — and sorry the experience wasn't smoother";
    case "team_change":
      return "Best of luck — we're here whenever the team's ready again";
    case "no_longer_needed":
      return "Best of luck with what's next";
    case "support_quality":
      return "Sorry we couldn't help — and a discount if you'd like another shot";
    case "other":
      return "Sorry to see you go";
    default: {
      // Exhaustiveness check — TypeScript will error if a new category is
      // added to CANCELLATION_CATEGORIES without updating this switch.
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

function reasonAddressing(category: CancellationCategory): string {
  switch (category) {
    case "pricing":
      return "We hear you on the cost. We've put together a one-time discount in case it helps.";
    case "missing_features":
      return "If a specific feature was missing, we'd love to hear which — even a one-line reply helps shape the roadmap.";
    case "moving_to_competitor":
      return "Whatever you're moving to, hope it works out. If not, the door's open.";
    case "lack_of_usage":
      return "Sometimes the timing isn't right. If it ever is, here's a discount to help.";
    case "technical_issues":
      return "We don't love when things break. If you'd give us another shot, we'd appreciate it.";
    case "team_change":
      return "Things change fast at startups. We'll keep your account around for a while.";
    case "no_longer_needed":
      return "Glad you got what you needed. We're here if life sends you back.";
    case "support_quality":
      return "Sorry we missed the mark on support. We're working on it.";
    case "other":
      return "Whatever the reason, we appreciate you trying us out.";
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

function appendCouponParam(baseUrl: string, couponCode: string): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}coupon=${encodeURIComponent(couponCode)}`;
}

function renderHtml(parts: {
  greeting: string;
  reason: string;
  couponCode: string;
  ctaUrl: string;
}): string {
  const greeting = escapeHtml(parts.greeting);
  const reason = escapeHtml(parts.reason);
  const couponCode = escapeHtml(parts.couponCode);
  const ctaUrl = escapeHtml(parts.ctaUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>${greeting}</p>
  <p>We're sorry to see you go. ${reason}</p>
  <p>If you'd like to come back, here's a one-time <strong>${couponCode}</strong> discount on your next 3 months:</p>
  <p>
    <a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;background-color:#0066cc;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold">Reactivate with discount →</a>
  </p>
  <p>Either way — thank you for trying us out, and good luck with what's next.</p>
  <p>— The FounderOS team</p>
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

// ── Type-only re-export for caller convenience ────────────────────────────

export type { CancellationCategory };
export { CANCELLATION_CATEGORIES };
