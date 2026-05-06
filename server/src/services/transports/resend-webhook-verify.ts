/**
 * resend-webhook-verify.ts — Svix-format signature verification for Resend webhooks.
 *
 * Council 2026-05-05 W0.2c BLOCK fix companion. Verifies the `svix-id`,
 * `svix-timestamp`, and `svix-signature` headers against the configured
 * RESEND_WEBHOOK_SECRET (which begins with `whsec_` — Svix convention).
 *
 * No SDK dependency. Per .planning/PROJECT.md "no new external dependencies
 * without ADR" + the slopsquatting-guard invariant: the Svix verification
 * scheme is ~30 lines of Node `crypto`, cheaper to audit than the alternative.
 *
 * Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
 *  - secret: base64-decoded after stripping the `whsec_` prefix
 *  - toSign: `${svix-id}.${svix-timestamp}.${rawBody}`
 *  - expected: `v1,${base64(hmac-sha256(secret, toSign))}`
 *  - header may carry multiple space-separated signatures for rotation:
 *      "v1,sig1 v1,sig2"
 *  - any one matching signature passes verification
 *  - timestamp tolerance: ±5 minutes (clock skew + Resend delivery latency)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SvixVerifyResult {
  ok: boolean;
  reason?:
    | "missing-headers"
    | "bad-secret-format"
    | "stale-timestamp"
    | "signature-mismatch";
}

const TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes

/**
 * verifySvixSignature — verify a Resend / Svix-signed webhook.
 *
 * @param secret    `whsec_...` (raw env var value as set by the operator)
 * @param svixId    `svix-id` request header
 * @param svixTs    `svix-timestamp` request header (unix seconds, string)
 * @param svixSig   `svix-signature` request header (one or more `v1,...` entries)
 * @param rawBody   Buffer containing the original POST body (no JSON parse)
 * @param now       Optional clock injection for tests; defaults to Date.now()
 */
export function verifySvixSignature(
  secret: string,
  svixId: string | undefined,
  svixTs: string | undefined,
  svixSig: string | undefined,
  rawBody: Buffer,
  now: () => number = Date.now,
): SvixVerifyResult {
  if (!svixId || !svixTs || !svixSig) {
    return { ok: false, reason: "missing-headers" };
  }

  // Strip prefix; Svix secrets always begin with `whsec_`. Anything else is
  // a misconfiguration — fail closed rather than try to use the raw value.
  if (!secret.startsWith("whsec_")) {
    return { ok: false, reason: "bad-secret-format" };
  }
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  if (secretBytes.length === 0) {
    return { ok: false, reason: "bad-secret-format" };
  }

  // Timestamp tolerance — replay-prevention. svix-timestamp is unix seconds.
  const tsMs = Number(svixTs) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now() - tsMs) > TOLERANCE_MS) {
    return { ok: false, reason: "stale-timestamp" };
  }

  const toSign = `${svixId}.${svixTs}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secretBytes).update(toSign).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  // Header may carry multiple signatures: "v1,sig1 v1,sig2 v2,sigN".
  // Accept if ANY v1 signature matches under timing-safe compare.
  for (const part of svixSig.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const sigBuf = Buffer.from(sig, "utf8");
    if (sigBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature-mismatch" };
}
