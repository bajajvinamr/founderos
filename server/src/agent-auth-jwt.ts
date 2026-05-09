import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

/**
 * Thrown when FOUNDEROS_AGENT_JWT_SECRET is not present in process.env at the
 * point where a JWT is needed. This is a server-misconfiguration failure
 * (NOT a runtime "your token is invalid" failure) — the type system and
 * dev-mode auto-bootstrap (`server/src/boot/jwt-secret-bootstrap.ts`) make
 * this branch unreachable in normal operation.
 *
 * Distinct from runtime verification failures (bad signature, expired token,
 * missing claims) which continue to return null from `verifyLocalAgentJwt` —
 * those are legitimate "this token is not valid" outcomes that callers
 * already handle as 401.
 */
export class AgentJwtSecretMissingError extends Error {
  readonly code = "agent_jwt_secret_missing";
  constructor() {
    super(
      "FOUNDEROS_AGENT_JWT_SECRET is not configured. " +
        "Local-CLI agents cannot authenticate to the FounderOS API without it. " +
        "In development: this should be auto-bootstrapped at boot — file a bug. " +
        "In production: run `pnpm founderos onboard` or set the secret explicitly.",
    );
    this.name = "AgentJwtSecretMissingError";
  }
}

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfigOrThrow() {
  const secret = process.env.FOUNDEROS_AGENT_JWT_SECRET?.trim();
  if (!secret) throw new AgentJwtSecretMissingError();

  return {
    secret,
    ttlSeconds: parseNumber(process.env.FOUNDEROS_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.FOUNDEROS_AGENT_JWT_ISSUER ?? "founderos",
    audience: process.env.FOUNDEROS_AGENT_JWT_AUDIENCE ?? "founderos-api",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Issue a signed local-agent JWT. Throws `AgentJwtSecretMissingError` when
 * the server is missing the signing secret — the type system therefore makes
 * the "no token" path unrepresentable at every call site (heartbeat,
 * adapter spawn, etc.). Callers that previously did `if (!token) ...` should
 * delete that branch — it is now unreachable.
 */
export function createLocalAgentJwt(
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
): string {
  const config = jwtConfigOrThrow();

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
    jti: randomUUID(),
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * Verify a local-agent JWT. Returns the decoded claims on success, or `null`
 * when the token itself is invalid (bad signature, expired, missing claims,
 * issuer/audience mismatch). Throws `AgentJwtSecretMissingError` when the
 * server has no signing secret — that is a misconfiguration, not "this
 * token is invalid," and the auth middleware should not silently treat it
 * as anonymous-fallback.
 */
export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  // Missing config throws — surfaces server misconfiguration loud rather
  // than silently masquerading as "token rejected."
  const config = jwtConfigOrThrow();

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : null;
  const audience = typeof claims.aud === "string" ? claims.aud : null;
  if (!issuer || issuer !== config.issuer) return null;
  if (!audience || audience !== config.audience) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    iss: issuer,
    aud: audience,
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
