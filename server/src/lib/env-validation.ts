/**
 * Startup environment validation.
 *
 * Each entry is a "feature gate" — an env var (or set) that, when present,
 * enables a critical production capability. Missing in production = silent
 * degradation, which is exactly the failure mode the 2026-05-03 council audit
 * flagged as systemic. This module makes the failure loud at boot, NOT lazy.
 *
 * Three severities:
 *   - REQUIRED_IN_PROD: hard fail (process.exit) when NODE_ENV=production
 *   - WARN: log warn at boot — feature is degraded but server continues
 *   - INFO: log info — purely informational about what's enabled
 *
 * In development / local_trusted modes we never hard-fail — the dev workflow
 * needs to run without every secret wired.
 */

import type { Logger } from "pino";

export type EnvSeverity = "REQUIRED_IN_PROD" | "WARN" | "INFO";

interface EnvCheck {
  /** Display name for log messages. */
  name: string;
  /** Env var keys that must be present. ALL of them — partial is treated as missing. */
  keys: string[];
  /** What this enables. */
  enables: string;
  /** Severity when missing. */
  severity: EnvSeverity;
  /** What the user/operator should do if it's missing. */
  hint?: string;
}

const CHECKS: EnvCheck[] = [
  // --- auth-related (WARN — not load-bearing post-2026-05-03) ---
  // SUPABASE_WEBHOOK_SECRET: webhook is audit-only after the email-squatting
  // fix; bootstrap moved to first authed request. BETTER_AUTH_SECRET: only
  // matters when FOUNDEROS_AUTH_PROVIDER=better-auth, which the Fly deploy
  // doesn't use (supabase). Graduate to REQUIRED_IN_PROD only after Fly
  // boot logs confirm both are set in prod.
  {
    name: "SUPABASE_WEBHOOK_SECRET",
    keys: ["SUPABASE_WEBHOOK_SECRET"],
    enables: "Supabase user.created webhook signature verification (audit-only)",
    severity: "WARN",
    hint:
      "Optional after 2026-05-03 — webhook is audit-only; bootstrap deferred to first authed request via maybeBootstrapNewUser.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    keys: ["BETTER_AUTH_SECRET"],
    enables:
      "OAuth state signing (Slack/HubSpot/LinkedIn/Notion) AND Better-Auth session encryption",
    severity: "REQUIRED_IN_PROD",
    hint:
      "Despite the name, this secret is also load-bearing for OAuth state signing in EVERY auth provider — see " +
      "server/src/services/oauth/state-store.ts:23 which throws if unset. signOAuthState() is called " +
      "unconditionally in routes/oauth.ts whenever a user starts an integration connect flow. Council " +
      "2026-05-03 P2 (Codex): pre-fix this was misclassified as Better-Auth-only WARN, so prod could boot " +
      "and then throw at the first integration OAuth attempt. Now load-bearing in prod for any deploy that " +
      "exposes the integrations UI.",
  },
  // --- billing (loud warn — billing is BLOCK per 2026-05-03 council, but live keys deferred) ---
  {
    name: "STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET",
    keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    enables: "Stripe billing (checkout, subscription webhook signature verify)",
    severity: "WARN",
    hint:
      "Live keys deferred per CONTINUE.md. With these unset, /api/billing/checkout returns 503 and the " +
      "subscription webhook is unmounted — billing gate fails open (2026-05-03 council P1 — fix in flight).",
  },
  // --- AI providers ---
  {
    name: "ANTHROPIC_API_KEY",
    keys: ["ANTHROPIC_API_KEY"],
    enables: "Claude API adapter for agent execution",
    severity: "WARN",
    hint:
      "Founders can BYO key per-company; this server-level key is only the fallback. Without it AND " +
      "without a per-company key, all agent runs fail at first invocation.",
  },
  {
    name: "OPENAI_API_KEY",
    keys: ["OPENAI_API_KEY"],
    enables: "OpenAI / Codex adapter fallback for agent execution",
    severity: "WARN",
    hint:
      "Used by server/src/adapters/codex-models.ts as the host-level fallback when a founder hasn't " +
      "configured per-company codex auth. Without it AND without ~/.codex/auth.json, codex_local " +
      "agents fall through to the no-auth path and run-time invocation throws. PR-11 (council 2026-05-07).",
  },
  // --- integrations ---
  {
    name: "COMPOSIO_API_KEY",
    keys: ["COMPOSIO_API_KEY"],
    enables: "Composio v3 OAuth + tool execution (Slack, Gmail, Drive, etc.)",
    severity: "WARN",
    hint:
      "If unset, the Integrations page silently disables third-party connectors. Set this AND " +
      "COMPOSIO_AUTH_CONFIG_<APP> for each toolkit you want enabled.",
  },
  {
    name: "COMPOSIO_V3_READY",
    keys: ["COMPOSIO_V3_READY"],
    enables: "Composio v3 routes (must be set to '1' explicitly to enable)",
    severity: "INFO",
  },
  // --- runner (BYO Runner — ADR-011, 2026-05-04) ---
  {
    name: "FOUNDEROS_BYO_RUNNER_ENABLED",
    keys: ["FOUNDEROS_BYO_RUNNER_ENABLED"],
    enables: "byo_runner adapter + /api/runner/* routes + new-signup default in onboarding",
    severity: "INFO",
    hint:
      "Set to '1' to enable the BYO Runner architecture (ADR-011). When unset, the runner adapter is not " +
      "registered, /api/runner/* returns 404, and onboarding shows the legacy claude_local picker. " +
      "Default-off until E2E green per the Sprint 0 rollout plan.",
  },
  // --- observability ---
  {
    name: "SENTRY_DSN",
    keys: ["SENTRY_DSN"],
    enables: "Server error tracking via Sentry",
    severity: "WARN",
    hint:
      "Strongly recommended in prod — without Sentry, server errors are only visible in pino logs which " +
      "are not searched for production triage. Verify post-deploy with `GET /api/debug/sentry-canary`.",
  },
  // --- auth provider: Supabase (load-bearing when FOUNDEROS_AUTH_PROVIDER=supabase, the prod default) ---
  {
    name: "SUPABASE_URL + SUPABASE_ANON_KEY",
    keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    enables:
      "Supabase auth provider — JWKS endpoint base for ES256 JWT verification + UI client signin/signup",
    severity: "WARN",
    hint:
      "Effectively REQUIRED in prod when FOUNDEROS_AUTH_PROVIDER=supabase (the Fly default). server/src/" +
      "index.ts:530 throws at boot when SUPABASE_URL is unset under that provider, so this WARN is the " +
      "early signal before the throw. SUPABASE_ANON_KEY is needed by the UI client; without it, signin " +
      "lands on a non-functional Supabase client. PR-11 (council 2026-05-07).",
  },
  // --- email transport (S4.8 prereq #196 + earlier W0.2) ---
  {
    name: "RESEND_API_KEY",
    keys: ["RESEND_API_KEY"],
    enables: "Resend transactional email transport (welcome, magic-link, daily digest, weekly wrap)",
    severity: "WARN",
    hint:
      "Used by server/src/app.ts:542 / index.ts:602. Without it, all email sends silently no-op (Resend " +
      "client errors are caught and logged). The daily-digest, weekly-wrap, magic-link, and welcome " +
      "flows ALL depend on this; missing it in prod = customer-facing email surface goes dark. " +
      "PR-11 (council 2026-05-07).",
  },
  {
    name: "EMAIL_UNSUBSCRIBE_SECRET",
    keys: ["EMAIL_UNSUBSCRIBE_SECRET"],
    enables:
      "HMAC signing key for one-click unsubscribe tokens on customer-facing workflow emails " +
      "(onboarding, activation-nudge, upsell, churn-rescue). CAN-SPAM/GDPR compliance gate.",
    severity: "WARN",
    hint:
      "Effectively REQUIRED before any customer-email send: server/src/services/email-unsubscribe-tokens.ts " +
      "throws at runtime when this is unset. WARN-severity at boot ONLY because customer-email autonomy=4 " +
      "is gated separately and not yet GA. Graduate to REQUIRED_IN_PROD when the customer-email templates " +
      "ship to design partners (S6 polish or sooner). Generate with `openssl rand -hex 48`. Council " +
      "2026-05-06 finding #4 (CAN-SPAM/GDPR BLOCK) — see decisions.md.",
  },
];

interface ValidationResult {
  hardFails: EnvCheck[];
  warns: EnvCheck[];
  infos: EnvCheck[];
  oks: EnvCheck[];
}

function check(envCheck: EnvCheck): boolean {
  return envCheck.keys.every((k) => {
    const v = process.env[k]?.trim();
    return Boolean(v && v.length > 0);
  });
}

/**
 * Evaluate env against a list of checks. Defaults to the production
 * CHECKS table; tests can pass their own list to verify validator
 * behavior without coupling to which specific keys are REQUIRED.
 */
export function evaluateEnv(checks: EnvCheck[] = CHECKS): ValidationResult {
  const hardFails: EnvCheck[] = [];
  const warns: EnvCheck[] = [];
  const infos: EnvCheck[] = [];
  const oks: EnvCheck[] = [];

  for (const c of checks) {
    if (check(c)) {
      oks.push(c);
      continue;
    }
    if (c.severity === "REQUIRED_IN_PROD") hardFails.push(c);
    else if (c.severity === "WARN") warns.push(c);
    else infos.push(c);
  }

  return { hardFails, warns, infos, oks };
}

export interface ValidateEnvOptions {
  /** When true, REQUIRED_IN_PROD failures become process.exit(1). */
  strict: boolean;
  /** Pino logger for emitting boot diagnostics. */
  logger: Pick<Logger, "info" | "warn" | "error" | "fatal">;
  /** Test-only override of the checks list. Production callers use the default. */
  checks?: EnvCheck[];
}

/**
 * Validate environment at startup. Logs every miss with a hint, and
 * hard-fails (process.exit) if `strict=true` AND a REQUIRED_IN_PROD
 * gate is missing.
 *
 * Call this AFTER `loadConfig()` so dotenv + .env.local + repaired
 * worktree env files are merged in.
 */
export function validateEnvOrExit(opts: ValidateEnvOptions): ValidationResult {
  const { logger, strict } = opts;
  const result = evaluateEnv(opts.checks);

  for (const c of result.oks) {
    logger.info({ envCheck: c.name, enables: c.enables }, `env: ✓ ${c.name}`);
  }

  for (const c of result.warns) {
    logger.warn(
      { envCheck: c.name, enables: c.enables, hint: c.hint, missing: c.keys },
      `env: ⚠ ${c.name} not set — ${c.enables} disabled`,
    );
  }

  for (const c of result.infos) {
    logger.info(
      { envCheck: c.name, enables: c.enables, missing: c.keys },
      `env: – ${c.name} not set — ${c.enables}`,
    );
  }

  if (result.hardFails.length > 0) {
    for (const c of result.hardFails) {
      logger.error(
        { envCheck: c.name, enables: c.enables, hint: c.hint, missing: c.keys },
        `env: ✗ ${c.name} REQUIRED — ${c.enables} cannot start`,
      );
    }
    if (strict) {
      logger.fatal(
        { failures: result.hardFails.map((c) => c.name) },
        "Refusing to boot: required production env vars are missing. Set them or run with NODE_ENV != production.",
      );
      // Give pino transports a chance to flush before exit.
      setTimeout(() => process.exit(1), 200);
      // Throw so callers see the failure synchronously too.
      throw new Error(
        `Missing required env vars in production: ${result.hardFails.map((c) => c.name).join(", ")}`,
      );
    }
  }

  return result;
}
