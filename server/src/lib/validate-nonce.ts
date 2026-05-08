/**
 * Single-use nonce primitive for the unauthenticated /api/providers/validate-key
 * endpoint (S7.A.6, council 2026-05-08 P1 — IP-rotation defense).
 *
 * Why this exists:
 *   The validate-key endpoint is unauthenticated (called pre-account during
 *   onboarding). Pure IP-based rate limiting (10/5min/IP) is bypassable by
 *   anyone with a residential proxy plan (~$5/mo). Binding each validation
 *   to a single-use nonce — issued by a separately rate-limited endpoint —
 *   doubles attacker round-trip cost: an attacker rotating IPs must call
 *   issue-nonce (5/min/IP) AND validate-key (10/5min/IP), so the effective
 *   ceiling is min(both) = 5/min/IP. Both endpoints rate-limit independently.
 *
 * Wire format:
 *   `<expiresAtSeconds>.<randomHex>.<hmacHex>`
 *   - expiresAtSeconds: epoch seconds when the nonce expires (60s after issue)
 *   - randomHex: 16 bytes of CSPRNG, hex-encoded → 32 chars
 *   - hmacHex: HMAC-SHA256(NONCE_SECRET, "<expiresAtSeconds>.<randomHex>")
 *              hex-encoded → 64 chars
 *   Total wire size: ~110 chars including separators.
 *
 * Single-use guarantee:
 *   Issued nonces are remembered in an in-process LRU Set. The first
 *   `consume(nonce)` call for a given hash returns true; subsequent calls
 *   return false. The Set is bounded (1024 entries) — an attacker can
 *   exhaust it by issuing nonces faster than the TTL window, but each
 *   issuance is rate-limited per-IP, so the effective exhaustion rate
 *   matches the issuance rate-limit anyway.
 *
 *   IMPORTANT: This is correct ONLY for single-process deploys (current
 *   FounderOS prod is single-machine on Fly). Multi-machine deploys must
 *   move to Redis SETNX with TTL to share the consumed-set across nodes.
 *   The function set is structured so a future swap is local to this file.
 *
 * Secret source:
 *   - Production: `FOUNDEROS_NONCE_SECRET` env var (32-byte hex required).
 *     Fail-loud at boot via env-validation.ts.
 *   - Dev: process-startup random (rotates across restarts; fine for 60s
 *     TTL nonces — outstanding nonces just become invalid on reload).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE_TTL_SECONDS = 60;
const RANDOM_BYTES = 16;
const CONSUMED_SET_CAP = 1024;

/**
 * Hash the caller's IP so we can sign a stable opaque token over it
 * without leaking the raw IP into the wire format. sha256, hex, first
 * 16 chars — collision space is 2^64 which is plenty for IP-binding.
 * Empty / unknown IP gets a deterministic sentinel so the binding
 * still works on `req.ip = "unknown"` paths (treated as "any unknown
 * is the same caller", which is conservative).
 */
function ipHash(ip: string | null | undefined): string {
  const normalized = (ip ?? "unknown").trim() || "unknown";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const PROD = process.env.NODE_ENV === "production";

/**
 * Resolve the HMAC secret. In production the env var is required; in
 * dev/test we generate a per-process random. Keep this getter lazy so
 * tests can mutate `process.env.FOUNDEROS_NONCE_SECRET` between runs
 * without restarting the module — required for the secret-rotation
 * test that proves nonces from one secret are rejected under another.
 */
let cachedSecret: Buffer | null = null;
let cachedSecretSource: string | null = null;

function getNonceSecret(): Buffer {
  const fromEnv = process.env.FOUNDEROS_NONCE_SECRET?.trim();
  // Re-derive when the env var changes between calls (tests).
  if (fromEnv && fromEnv !== cachedSecretSource) {
    cachedSecret = Buffer.from(fromEnv, "hex");
    cachedSecretSource = fromEnv;
    if (cachedSecret.length < 32) {
      throw new Error(
        "FOUNDEROS_NONCE_SECRET must be at least 32 bytes (64 hex chars).",
      );
    }
    return cachedSecret;
  }
  if (cachedSecret) return cachedSecret;
  if (PROD) {
    throw new Error(
      "FOUNDEROS_NONCE_SECRET is required in production but is not set.",
    );
  }
  // Dev / test fallback — process-lifetime random.
  cachedSecret = randomBytes(32);
  cachedSecretSource = "<dev-random>";
  return cachedSecret;
}

/**
 * In-process LRU Set of consumed nonces. Uses Map for O(1) insertion-order
 * eviction (Map.keys() iterates in insertion order). Capped at
 * CONSUMED_SET_CAP — old entries fall out FIFO. Auto-cleanup of expired
 * entries happens lazily during consume(); we don't run a timer.
 *
 * Storage: `<hmacHex>` → `<expiresAtSeconds>` (so the cleanup pass can
 * detect already-expired entries during eviction without re-parsing).
 */
const consumed = new Map<string, number>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface IssuedNonce {
  /** Wire-format token: `<expiresAtSec>.<randomHex>.<hmacHex>`. */
  nonce: string;
  /** Unix epoch seconds when this nonce becomes invalid. */
  expiresAt: number;
}

/**
 * Issue a fresh single-use nonce, bound to the caller's IP.
 *
 * S7.A.6 council 2026-05-08 post-fix R1 P1: the IP is signed into the HMAC
 * payload — verified against `req.ip` at consume time. An attacker rotating
 * residential proxies must now successfully validate against the SAME IP
 * that issued the nonce, which means the nonce is single-use AND
 * single-IP. Together with the per-IP rate limits on both endpoints, this
 * actually closes the rotation bypass (was previously: 1 issue per IP + 1
 * validate per IP = 1 validation per rotation; now: rotation invalidates
 * the nonce so the validate fails).
 *
 * Caller is responsible for IP rate-limiting (the issue endpoint mounts
 * `issueNonceLimiter` from rate-limit.ts).
 */
export function issueNonce(callerIp: string | null | undefined): IssuedNonce {
  const secret = getNonceSecret();
  const expiresAt = nowSeconds() + NONCE_TTL_SECONDS;
  const random = randomBytes(RANDOM_BYTES).toString("hex");
  const ipBinding = ipHash(callerIp);
  // Wire payload is unchanged for backwards-compat — the IP-binding is
  // INSIDE the HMAC payload, not on the wire. Server has both halves at
  // consume time; any IP mismatch surfaces as `bad_signature`.
  const signingPayload = `${expiresAt}.${random}.${ipBinding}`;
  const wirePayload = `${expiresAt}.${random}`;
  const hmac = sign(signingPayload, secret);
  return {
    nonce: `${wirePayload}.${hmac}`,
    expiresAt,
  };
}

export type ConsumeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "malformed"
        | "expired"
        | "bad_signature"
        | "already_consumed"
        | "cap_exhausted";
    };

/**
 * Verify and consume a nonce. Returns ok:true exactly once per valid
 * nonce, even under concurrent calls (insertion to the consumed Map is
 * atomic in a single Node event-loop turn — no need for an explicit lock
 * within one process).
 *
 * The caller's IP MUST match the IP that issued the nonce — IP mismatch
 * surfaces as `bad_signature` (no oracle for IP guessing).
 */
export function consumeNonce(
  raw: unknown,
  callerIp: string | null | undefined,
): ConsumeResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [expiresAtStr, random, hmac] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (random.length !== RANDOM_BYTES * 2 || !/^[0-9a-f]+$/i.test(random)) {
    return { ok: false, reason: "malformed" };
  }
  if (hmac.length !== 64 || !/^[0-9a-f]+$/i.test(hmac)) {
    return { ok: false, reason: "malformed" };
  }

  // Verify signature BEFORE checking expiry (prevents an oracle that lets
  // an attacker probe expiry without holding a valid HMAC). The signing
  // payload includes the caller's ip-hash, so an IP mismatch between
  // issuance and consumption fails this check — no separate "wrong_ip"
  // reason surfaces.
  const secret = getNonceSecret();
  const expected = sign(
    `${expiresAtStr}.${random}.${ipHash(callerIp)}`,
    secret,
  );
  if (!safeEqualHex(hmac, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Now check expiry.
  if (expiresAt <= nowSeconds()) {
    return { ok: false, reason: "expired" };
  }

  // Single-use check.
  if (consumed.has(hmac)) {
    return { ok: false, reason: "already_consumed" };
  }

  // Cap enforcement: sweep expired entries first, then refuse if still
  // at cap. S7.A.6 council 2026-05-08 post-fix R1 P2: the prior FIFO
  // eviction could remove an unexpired consumed nonce when the cap was
  // hit, opening a replay window. New behavior: only expired entries are
  // ever evicted; if all 1024 entries are unexpired, we refuse the new
  // consume (cap_exhausted) instead of replacing one. The caller-tier
  // rate limits prevent legitimate users from hitting this; an attacker
  // hitting it is being throttled by intent.
  if (consumed.size >= CONSUMED_SET_CAP) {
    sweepExpired();
    if (consumed.size >= CONSUMED_SET_CAP) {
      return { ok: false, reason: "cap_exhausted" };
    }
  }

  consumed.set(hmac, expiresAt);
  return { ok: true };
}

/**
 * Sweep expired entries from the consumed Set. O(N) but called only on
 * cap-overflow, so amortized cost is bounded by issuance rate.
 */
function sweepExpired(): void {
  const now = nowSeconds();
  for (const [key, exp] of consumed) {
    if (exp <= now) consumed.delete(key);
  }
}

/**
 * Test-only: clear the in-process consumed set. NOT exported via the
 * production barrel — only imported directly from tests.
 */
export function __resetConsumedNoncesForTests(): void {
  consumed.clear();
  cachedSecret = null;
  cachedSecretSource = null;
}
