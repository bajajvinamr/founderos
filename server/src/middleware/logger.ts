import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { getRequestContext } from "../lib/request-context.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.FOUNDEROS_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const SENSITIVE_KEYS = new Set([
  "password", "passwd", "secret", "token", "apikey", "api_key",
  "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "authorization", "auth", "credential", "credentials", "privatekey",
  "private_key", "clientsecret", "client_secret",
  // PR-7 (council 2026-05-07 P1): tokens that previously leaked unredacted
  // because pino's path-based redact only covered req.headers.authorization.
  // signupUrl carries the raw `pcp_<48hex>` invite token in a query param;
  // magic-link / runner / refresh tokens follow the same shape contract.
  "signupurl", "magiclinktoken", "magic_link_token",
  "runnertoken", "runner_token", "inviteurl", "invite_url",
]);

/**
 * Path-based redaction list for pino's top-level `redact` option. Paths are
 * dot-separated; bracket notation handles keys with hyphens (`x-runner-token`).
 *
 * What this protects (PR-7, 2026-05-07):
 *   - HTTP request headers: Authorization, Cookie, x-runner-token, x-api-key
 *     (bearer tokens, session cookies, runner identity tokens)
 *   - Top-level fields in custom logger.* calls: signupUrl, token, password,
 *     apiKey, secret, credentials, refresh/access/client tokens, magic-link
 *     and runner tokens. The `pino-http` body redaction at customProps
 *     covers HTTP body / params / query (via `redactSensitive`); this list
 *     covers EVERYTHING ELSE (direct `logger.info({ ... }, "...")` calls).
 *
 * NOTE: Wildcards in pino paths only cover ONE level (`req.headers.*` would
 * redact every header). We list specific keys instead — narrow blast radius,
 * keeps unrelated debug fields visible.
 */
/**
 * Redaction sentinel — matches the lowercase `[redacted]` used by
 * `redactSensitive` so a single log record never mixes sentinels.
 */
export const REDACT_CENSOR = "[redacted]" as const;

export const REDACT_PATHS: readonly string[] = [
  // HTTP request headers
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-runner-token"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  // Top-level keys in custom logger.* calls. Pino's path matcher treats
  // these as root-level — a `logger.info({ signupUrl }, "...")` call gets
  // its `signupUrl` redacted before serialization.
  "signupUrl",
  "signup_url",
  "inviteUrl",
  "invite_url",
  "token",
  "password",
  "apiKey",
  "api_key",
  "secret",
  "credentials",
  "credential",
  "privateKey",
  "private_key",
  "refreshToken",
  "refresh_token",
  "accessToken",
  "access_token",
  "clientSecret",
  "client_secret",
  "magicLinkToken",
  "magic_link_token",
  "runnerToken",
  "runner_token",
  "authorization",
];

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[redacted]" : redactSensitive(v, depth + 1);
  }
  return out;
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");
const logLevel = process.env.LOG_LEVEL ?? "info";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: logLevel,
  // Match the lowercase `[redacted]` sentinel used by `redactSensitive`
  // (the JSON-tree redactor used in pino-http customProps for body /
  // params / query). Default pino censor is `[Redacted]` (capital R)
  // which would have produced two different sentinels in the same log
  // record — confusing for downstream log parsers and Sentry filters.
  redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  // Auto-inject the active requestId / traceId / actor on every log call —
  // including background tasks (heartbeat runs, agent execution, db queries)
  // that aren't tied to an HTTP req. Reads from AsyncLocalStorage. Returns
  // empty when called outside a request context (e.g. boot logs).
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) return {};
    return {
      reqId: ctx.requestId,
      traceId: ctx.traceId,
      ...(ctx.routePath ? { routePath: ctx.routePath } : {}),
      ...(ctx.actor?.userId ? { actorUserId: ctx.actor.userId } : {}),
      ...(ctx.actor?.type ? { actorType: ctx.actor.type } : {}),
      // BYO-109 — runner identity for cloud-side log correlation.
      ...(ctx.actor?.runnerTokenId ? { actorRunnerTokenId: ctx.actor.runnerTokenId } : {}),
    };
  },
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: logLevel,
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          reqQuery: redactSensitive(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactSensitive(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
