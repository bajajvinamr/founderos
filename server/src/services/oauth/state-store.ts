/**
 * OAuth state token — signed, time-limited, tamper-evident.
 *
 * Format: base64url(payload_json) + "." + base64url(hmac_sha256)
 * Signing secret: BETTER_AUTH_SECRET env var
 * TTL: 600 seconds (10 minutes)
 */

import { createHmac } from "node:crypto";

const STATE_TTL_SECONDS = 600;

export type OAuthStatePayload = {
  companyId: string;
  kind: "slack" | "hubspot" | "linkedin" | "notion";
  returnUrl: string;
  nonce: string;
  issuedAt: number;
};

function getSigningSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required for OAuth state signing");
  }
  return secret;
}

function toBase64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8");
}

function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signOAuthState(payload: OAuthStatePayload): string {
  const payloadJson = JSON.stringify(payload);
  const encodedPayload = toBase64Url(payloadJson);
  const sig = hmacSign(encodedPayload, getSigningSecret());
  return `${encodedPayload}.${sig}`;
}

export type VerifyOAuthStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "invalid_signature" | "expired" | "malformed" };

export function verifyOAuthState(state: string): VerifyOAuthStateResult {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }

  const [encodedPayload, providedSig] = parts as [string, string];

  // Verify signature
  let expectedSig: string;
  try {
    expectedSig = hmacSign(encodedPayload, getSigningSecret());
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Constant-time comparison to prevent timing attacks
  if (providedSig !== expectedSig) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Decode payload
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).companyId !== "string" ||
    typeof (payload as Record<string, unknown>).kind !== "string" ||
    typeof (payload as Record<string, unknown>).returnUrl !== "string" ||
    typeof (payload as Record<string, unknown>).nonce !== "string" ||
    typeof (payload as Record<string, unknown>).issuedAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const p = payload as OAuthStatePayload;

  // Check TTL
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - p.issuedAt > STATE_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload: p };
}
