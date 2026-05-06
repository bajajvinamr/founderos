/**
 * email-unsubscribe-tokens — S4.8 prerequisite #196 layer 2.
 *
 * One-click unsubscribe tokens for customer-facing workflow templates
 * (onboarding-emails, activation-nudge, upsell, churn-rescue). HMAC-stateless
 * design: no DB row at send time; the token IS the proof. On click, the
 * route handler verifies the HMAC + creates a customer_email_suppressions
 * row for (companyId, contactEmail, topic).
 *
 * Why HMAC over stored tokens:
 *   - Zero DB writes per send (a 5000-recipient campaign generates 5000 fewer rows).
 *   - Replay-safe: customer_email_suppressions has a UNIQUE (companyId, contactEmail, topic)
 *     constraint. Re-clicking the same link is a no-op INSERT ... ON CONFLICT DO NOTHING.
 *   - CAN-SPAM compliant 10-day functional-link requirement is automatic — HMAC tokens
 *     never expire absent secret rotation. (For rotation: support multi-key verification
 *     during overlap windows; not needed for v1.)
 *
 * Format: `<base64url(payload-json)>.<base64url(hmac-sha256)>`
 *   - payload-json: { c: companyId, e: contactEmail (lowercase), t: topic, ts: epoch ms }
 *   - hmac key: EMAIL_UNSUBSCRIBE_SECRET env var (utf-8 bytes)
 *   - hmac input: the base64url-encoded payload string (NOT the raw JSON)
 *
 * Council 2026-05-06 finding #4 (BLOCK): customer-facing templates had NO suppression
 * model — every send risked CAN-SPAM / GDPR violation. Layer 1 shipped the suppression
 * fact table; this layer ships the token surface that turns email clicks into
 * suppression rows.
 *
 * The verifier is timing-safe (timingSafeEqual on equal-length buffers) — see
 * board-auth.ts:25 for the same pattern in the FounderOS codebase.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SuppressionTopic } from "@founderos/db";

const SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";

export interface UnsubscribeTokenPayload {
  /** Company UUID. */
  c: string;
  /** Contact email, normalized to lowercase. */
  e: string;
  /** Suppression topic from SUPPRESSION_TOPICS. */
  t: SuppressionTopic;
  /** Unix epoch milliseconds at token generation. */
  ts: number;
}

/**
 * Read the HMAC secret from env. Throws if unset — CAN-SPAM compliance requires
 * functional unsubscribe links, which require this secret. Production boot via
 * env-validation.ts catches missing secrets before any send happens.
 */
function getKey(): Buffer {
  const secret = process.env[SECRET_ENV];
  if (!secret) {
    throw new Error(
      `${SECRET_ENV} is not configured — cannot generate or verify unsubscribe ` +
        `tokens. CAN-SPAM compliance requires this. Set in fly secrets or .env.`,
    );
  }
  return Buffer.from(secret, "utf-8");
}

function computeHmac(payloadB64: string): string {
  return createHmac("sha256", getKey()).update(payloadB64).digest("base64url");
}

/**
 * Generate a token encoding (companyId, contactEmail, topic, generatedAt).
 * Caller embeds the token in the email's unsubscribe URL.
 */
export function generateUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
): string {
  const json = JSON.stringify(payload);
  const payloadB64 = Buffer.from(json, "utf-8").toString("base64url");
  const hmac = computeHmac(payloadB64);
  return `${payloadB64}.${hmac}`;
}

/**
 * Verify a token presented at the unsubscribe endpoint.
 * Returns the payload on valid HMAC + parseable JSON, null otherwise.
 *
 * Timing-safe HMAC compare. Tampered payloads, truncated tokens, foreign-secret
 * tokens, and malformed JSON all return null with no information leak about
 * which step failed.
 */
export function verifyUnsubscribeToken(
  token: string,
): UnsubscribeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, providedHmac] = parts;
  if (!payloadB64 || !providedHmac) return null;

  const expectedHmac = computeHmac(payloadB64);
  const provBuf = Buffer.from(providedHmac, "base64url");
  const expBuf = Buffer.from(expectedHmac, "base64url");
  if (provBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(provBuf, expBuf)) return null;

  let parsed: unknown;
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isUnsubscribeTokenPayload(parsed)) return null;
  return parsed;
}

function isUnsubscribeTokenPayload(
  v: unknown,
): v is UnsubscribeTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.c === "string" &&
    p.c.length > 0 &&
    typeof p.e === "string" &&
    p.e === p.e.toLowerCase() &&
    typeof p.t === "string" &&
    p.t.length > 0 &&
    typeof p.ts === "number" &&
    Number.isFinite(p.ts) &&
    p.ts > 0
  );
}

/**
 * Build the full one-click unsubscribe URL.
 *
 * Path: `/api/u/customer/:token` (route handler lands in layer 3).
 * Distinct from the founder-digest unsubscribe at `/api/digest/unsubscribe/:token`.
 */
export function buildUnsubscribeUrl(
  baseUrl: string,
  payload: UnsubscribeTokenPayload,
): string {
  const token = generateUnsubscribeToken(payload);
  // Strip any trailing slash on baseUrl to avoid double-slash.
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/api/u/customer/${token}`;
}
