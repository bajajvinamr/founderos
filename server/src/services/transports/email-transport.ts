/**
 * email-transport.ts — pluggable email sender for lifecycle CRM workflows
 *
 * Council 2026-05-05 W0.2 BLOCK fix — replaces the "v1: Log intent only"
 * placeholder in templates/{onboarding-emails,activation-nudge,upsell}.ts.
 * Buyer-trust break: founders saw workflow status="completed" while customer
 * inboxes stayed empty.
 *
 * ## Modes
 * - **Resend** (production / staging): real HTTP send to api.resend.com.
 *   Activated when RESEND_API_KEY env var is set AND NODE_ENV !== "test".
 *   No SDK dependency — uses fetch directly per .planning/PROJECT.md
 *   "No new external dependencies without ADR" constraint.
 * - **Capture** (tests + dev fallback): appends to in-memory array, returns
 *   a synthetic id. Tests assert against `getCapturedEmails()`. Dev runs
 *   without RESEND_API_KEY land here automatically with a one-time warn.
 *
 * ## Delivery semantics — important
 * Resend returns 200/201 with a message id when it ACCEPTS the email; that's
 * NOT the same as confirmed delivery. Real "completed" status requires the
 * Resend webhook (email.delivered event). For W0.2 this layer reports a
 * `status` of "queued" on accept; the templates flatten "queued" → workflow
 * action status="completed" provisionally. The webhook receiver (W0.2c, next
 * wake) will subscribe to email.delivered/email.bounced and update with
 * confirmed terminal state.
 *
 * ## Why not @resend/node SDK
 * Adding the SDK introduces a new package on the supply chain. The Resend
 * REST API is 4 endpoints, all simple JSON. fetch + a 30-line wrapper is
 * cheaper to audit and aligns with vinamr-invariants on slopsquatting risk.
 */

import { logger } from "../../middleware/logger.js";

export interface SendEmailInput {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  /** Optional Resend tag to thread the workflow_run id into delivery webhooks. */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  /** Provider-issued id; for capture mode, a synthetic UUID. */
  id: string;
  /**
   * "queued" — provider accepted; final state requires webhook (email.delivered).
   * "failed" — provider rejected synchronously (auth, payload, rate-limit).
   * Capture mode always returns "queued".
   */
  status: "queued" | "failed";
  /** On failed, the upstream reason — surfaced into workflow_run actions. */
  reason?: string;
}

export interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
  /** Mode tag for observability — "resend" / "capture". */
  readonly mode: string;
}

// ── Capture mode (tests + dev fallback) ─────────────────────────────────────

const captured: SendEmailInput[] = [];

class CaptureTransport implements EmailTransport {
  readonly mode = "capture";
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    captured.push(input);
    return {
      id: `capture-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      status: "queued",
    };
  }
}

/**
 * Test/dev helper — read all emails captured since the last reset.
 * Not exported in production paths (templates never read this).
 */
export function getCapturedEmails(): readonly SendEmailInput[] {
  return [...captured];
}

export function resetCapturedEmails(): void {
  captured.length = 0;
}

// ── Resend mode (production / staging) ──────────────────────────────────────

interface ResendApiResponse {
  id?: string;
  // Error shape per https://resend.com/docs/api-reference/errors
  name?: string;
  message?: string;
  statusCode?: number;
}

class ResendTransport implements EmailTransport {
  readonly mode = "resend";
  constructor(private apiKey: string, private endpoint = "https://api.resend.com/emails") {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
          tags: input.tags,
        }),
      });

      const json = (await response.json().catch(() => ({}))) as ResendApiResponse;

      if (!response.ok || !json.id) {
        const reason = json.message ?? `Resend HTTP ${response.status}`;
        logger.error(
          { to: input.to, status: response.status, reason },
          "resend send rejected",
        );
        return { id: "", status: "failed", reason };
      }

      return { id: json.id, status: "queued" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ to: input.to, err }, "resend send threw");
      return { id: "", status: "failed", reason };
    }
  }
}

// ── Resolution + singleton ──────────────────────────────────────────────────

let cached: EmailTransport | null = null;
let warnedNoKey = false;

/**
 * getEmailTransport — resolve the active transport for this process.
 *
 * Priority:
 *   1. NODE_ENV === "test"  → CaptureTransport (deterministic, no network)
 *   2. RESEND_API_KEY set    → ResendTransport
 *   3. fallback              → CaptureTransport with one-time warn
 *
 * Cached per-process. Re-resolves on env change is NOT supported; any test
 * mutating env should call `resetEmailTransport()` between cases.
 */
export function getEmailTransport(): EmailTransport {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV;
  const apiKey = process.env.RESEND_API_KEY;

  if (nodeEnv === "test") {
    cached = new CaptureTransport();
  } else if (apiKey && apiKey.trim().length > 0) {
    cached = new ResendTransport(apiKey.trim());
  } else {
    if (!warnedNoKey) {
      logger.warn(
        { nodeEnv },
        "RESEND_API_KEY unset — email transport falling back to capture mode. " +
          "Outbound emails will NOT be delivered. Set RESEND_API_KEY in prod.",
      );
      warnedNoKey = true;
    }
    cached = new CaptureTransport();
  }
  return cached;
}

/** Test-only: forget the cached transport so the next getEmailTransport() re-resolves. */
export function resetEmailTransport(): void {
  cached = null;
  warnedNoKey = false;
  resetCapturedEmails();
}
