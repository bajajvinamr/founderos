/**
 * email-wrapper.ts — S4.8 prerequisite #197.
 *
 * Transport-layer wrapper that enforces CAN-SPAM § 7704(a)(5) + GDPR Recital
 * 47 compliance on EVERY customer-facing email:
 *
 *   1. Per-tenant physical postal address must appear in the footer.
 *   2. Functional unsubscribe link must appear in the footer.
 *   3. Both must appear in BOTH text and HTML body parts.
 *
 * The wrapper is the LAST mile before transport.send() — even an LLM-generated
 * template body that "forgets" the footer (e.g., the future S4.8 churn-rescue
 * template where a prompt-injection attempt could try to strip the footer)
 * still gets the legally-required footer added by this layer.
 *
 * ## Fail-closed semantics
 *
 * If the company.physical_address is NULL (founder hasn't filled it in), the
 * wrapper REFUSES to send. The alternative is shipping a legally non-compliant
 * email on behalf of a founder who can be sued by their state AG. Refusing to
 * send + raising a clear error is the safer default.
 *
 * Workflow templates that go through the wrapper observe the refusal as a
 * `failed` action with a specific `compliance_address_missing` error, which
 * the founder UI surfaces as a Settings prompt rather than a transport bug.
 *
 * ## Idempotency
 *
 * The wrapper is idempotent under the "footer already present" case — it
 * detects a previously-injected footer block (recognized by the `<!-- founderos-compliance-footer -->`
 * HTML comment + the matching text-mode `[founderos-compliance-footer]` marker)
 * and skips re-injection. This means templates CAN render their own footer
 * (as 3c-2/3d/3e do today) without the wrapper double-injecting.
 *
 * ## Defense-in-depth ordering
 *
 *   template body → unsubscribe URL injected by template builder
 *                 → wrapper: ensure address + unsubscribe present (NO-OP if both already there)
 *                 → transport.send()
 */

import type { Db } from "@founderos/db";
import { companies } from "@founderos/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import type { SendEmailInput } from "./email-transport.js";

/**
 * Marker strings used to detect already-wrapped emails. Stable across
 * versions; changing them is a breaking change because in-flight emails
 * (Resend has retried) may carry the OLD marker. Treat as a public contract.
 */
const HTML_FOOTER_MARKER = "<!-- founderos-compliance-footer -->";
const TEXT_FOOTER_MARKER = "[founderos-compliance-footer]";

/**
 * Per-tenant context the wrapper needs at send time. Hydrated by callers
 * via `loadComplianceContextForCompany(db, companyId)`.
 */
export interface ComplianceContext {
  companyId: string;
  companyName: string;
  /** Required by CAN-SPAM § 7704(a)(5). NULL → wrapper refuses to send. */
  physicalAddress: string | null;
  /** Optional reply-to / support contact rendered alongside the unsubscribe link. */
  supportEmail: string | null;
}

/** Result of a wrap call. Failure is the "compliance refused" path. */
export type WrapResult =
  | { ok: true; wrapped: SendEmailInput; alreadyHadFooter: boolean }
  | { ok: false; reason: "compliance_address_missing"; companyId: string };

/**
 * loadComplianceContextForCompany — read the per-tenant context from the DB.
 *
 * Single-row read; cached lookup is the caller's responsibility (most send
 * paths are 1 email per workflow_run, so caching adds no benefit).
 */
export async function loadComplianceContextForCompany(
  db: Db,
  companyId: string,
): Promise<ComplianceContext | null> {
  const [row] = await db
    .select({
      id: companies.id,
      name: companies.name,
      physicalAddress: companies.physicalAddress,
      supportEmail: companies.supportEmail,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!row) return null;
  return {
    companyId: row.id,
    companyName: row.name,
    physicalAddress: row.physicalAddress,
    supportEmail: row.supportEmail,
  };
}

/**
 * wrapEmailForCompliance — augment a SendEmailInput with the legal footer
 * if it's missing.
 *
 * Inputs:
 *   - input: the template-built email (text + html may already carry a footer)
 *   - ctx: per-tenant compliance context loaded from companies row
 *   - unsubscribeUrl: the HMAC-signed unsubscribe link (from email-unsubscribe-tokens.ts)
 *
 * Behavior:
 *   - If ctx.physicalAddress is NULL → returns { ok: false, reason: 'compliance_address_missing' }
 *   - If body already contains the wrapper marker → returns input unchanged + alreadyHadFooter: true
 *   - Otherwise → injects the footer into both text and html, returns wrapped input
 */
export function wrapEmailForCompliance(
  input: SendEmailInput,
  ctx: ComplianceContext,
  unsubscribeUrl: string,
): WrapResult {
  if (!ctx.physicalAddress || ctx.physicalAddress.trim().length === 0) {
    return {
      ok: false,
      reason: "compliance_address_missing",
      companyId: ctx.companyId,
    };
  }

  const text = input.text ?? "";
  const html = input.html ?? "";
  const alreadyHasText = text.includes(TEXT_FOOTER_MARKER);
  const alreadyHasHtml = html.includes(HTML_FOOTER_MARKER);

  // If BOTH already present, leave alone — the template authored its own
  // marker-bearing footer (rare today; a future template could opt-in this way).
  if (alreadyHasText && alreadyHasHtml) {
    return { ok: true, wrapped: input, alreadyHadFooter: true };
  }

  const footerText = buildTextFooter(ctx, unsubscribeUrl);
  const footerHtml = buildHtmlFooter(ctx, unsubscribeUrl);

  return {
    ok: true,
    wrapped: {
      ...input,
      text: alreadyHasText ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${footerText}`,
      html: alreadyHasHtml ? html : appendBeforeBodyClose(html, footerHtml),
    },
    alreadyHadFooter: false,
  };
}

/**
 * buildTextFooter — plain-text legal footer.
 *
 * The TEXT_FOOTER_MARKER appears inside an HTML-style comment-bracket pair
 * — irregular for plain text but lets the marker be visually quiet in
 * monospace email viewers AND machine-readable by a future parser.
 */
function buildTextFooter(
  ctx: ComplianceContext,
  unsubscribeUrl: string,
): string {
  const supportLine = ctx.supportEmail
    ? `Questions? Reply to this email or write to ${ctx.supportEmail}.\n`
    : "";
  return [
    "",
    "----",
    `${ctx.companyName}`,
    ctx.physicalAddress!.trim(),
    "",
    supportLine + `Unsubscribe: ${unsubscribeUrl}`,
    `[founderos-compliance-footer]`,
  ].join("\n");
}

/**
 * buildHtmlFooter — HTML legal footer with marker comment.
 *
 * The marker comment is stripped by most spam filters that strip comments
 * (Outlook 2016 era quirk) — but we don't depend on visible presence; the
 * idempotency check looks at the raw `html` string before transport, which
 * still has the comment.
 */
function buildHtmlFooter(
  ctx: ComplianceContext,
  unsubscribeUrl: string,
): string {
  const supportLine = ctx.supportEmail
    ? `Questions? Reply to this email or write to <a href="mailto:${escapeHtml(ctx.supportEmail)}" style="color:#999">${escapeHtml(ctx.supportEmail)}</a>.<br>`
    : "";
  return `${HTML_FOOTER_MARKER}
<hr style="margin-top:32px;border:none;border-top:1px solid #eee">
<p style="font-size:12px;color:#999;line-height:1.5">
  <strong>${escapeHtml(ctx.companyName)}</strong><br>
  ${escapeHtml(ctx.physicalAddress!.trim()).replace(/\n/g, "<br>")}<br><br>
  ${supportLine}<a href="${escapeHtml(unsubscribeUrl)}" style="color:#999;text-decoration:underline">Unsubscribe</a>
</p>`;
}

/**
 * appendBeforeBodyClose — inject HTML at the end of `<body>...</body>` when
 * present, else just append.
 *
 * Many of our templates render a full `<!DOCTYPE html>...</html>` document.
 * Putting the footer BEFORE `</body>` keeps it within the rendered body
 * region. Some LLM-generated future templates may render fragments instead,
 * in which case append-at-end is fine.
 */
function appendBeforeBodyClose(html: string, footer: string): string {
  if (!html) return footer;
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) {
    return html + (html.endsWith("\n") ? "" : "\n") + footer;
  }
  return html.slice(0, idx) + footer + "\n" + html.slice(idx);
}

/**
 * escapeHtml — minimal HTML escape for footer interpolation.
 *
 * Duplicated from each template builder; could be hoisted to a shared util in
 * a follow-up but kept local here so the wrapper is self-contained (zero
 * cross-file deps for the legal-compliance code path).
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * sendWithCompliance — convenience wrapper that loads the context, wraps,
 * and sends in one call. Used by templates that don't already do their own
 * compliance-context loading.
 *
 * Returns the underlying transport result OR a synthetic
 * { status: 'failed', reason: 'compliance_address_missing' } result that
 * looks identical to a transport failure (so callers don't need a third
 * code path).
 */
export async function sendWithCompliance(args: {
  db: Db;
  companyId: string;
  unsubscribeUrl: string;
  input: SendEmailInput;
  send: (input: SendEmailInput) => Promise<{ id: string; status: "queued" | "failed"; reason?: string }>;
}): Promise<{ id: string; status: "queued" | "failed"; reason?: string; alreadyHadFooter?: boolean }> {
  const ctx = await loadComplianceContextForCompany(args.db, args.companyId);
  if (!ctx) {
    logger.error(
      { companyId: args.companyId, to: args.input.to },
      "email-wrapper: companies row not found; refusing to send",
    );
    return {
      id: "",
      status: "failed",
      reason: "company_not_found",
    };
  }

  const wrapped = wrapEmailForCompliance(args.input, ctx, args.unsubscribeUrl);
  if (!wrapped.ok) {
    logger.warn(
      { companyId: ctx.companyId, to: args.input.to, reason: wrapped.reason },
      "email-wrapper: refusing to send — physical address not configured",
    );
    return {
      id: "",
      status: "failed",
      reason: wrapped.reason,
    };
  }

  const result = await args.send(wrapped.wrapped);
  return { ...result, alreadyHadFooter: wrapped.alreadyHadFooter };
}
