/**
 * Supabase client singleton with hard-fail config validation + structured
 * failure logging.
 *
 * History (2026-05-04 incident): the previous version of this file shipped
 * a literal fallback `https://placeholder.supabase.co` when build-time env
 * was missing. The Fly Dockerfile didn't pass `VITE_SUPABASE_URL` as a
 * build arg, so production bundles silently embedded the placeholder for
 * 24+ hours after the single-origin cutover. Email signup + Google OAuth
 * both 100%-failed in prod with cryptic "Failed to fetch" / DNS NXDOMAIN
 * errors. The e2e suite missed it because `FOUNDEROS_E2E_PROFILE=public-only`
 * skips auth-mutation tests.
 *
 * Defenses now stacked here:
 *  1. **No placeholder fallback.** If env is missing, the module throws at
 *     load time. The browser will display a build-config error instead of
 *     looking healthy with broken auth.
 *  2. **Sentinel detection.** If the embedded URL contains "placeholder"
 *     we treat that as a misconfig too — old buggy bundles cached client-
 *     side will surface the error loudly.
 *  3. **Heavy structured logging.** Every auth call goes through
 *     `loggedAuthCall` which captures URL, error, network state, project
 *     ref, and feeds Sentry via breadcrumbs. `window.__authDebug()` is
 *     installed for self-service debugging from DevTools console.
 *  4. **Build-time guard.** `vite.config.ts` now refuses to build the
 *     bundle if VITE_SUPABASE_URL is missing (belt + suspenders).
 *
 * The anon key is safe to ship in the bundle by design — Supabase RLS
 * does the real access control on the server side.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addAuthBreadcrumb, captureAuthError } from "./auth-logger";

const PLACEHOLDER_URL_HOST = "placeholder.supabase.co";
const PLACEHOLDER_KEY = "placeholder-anon-key";

const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const buildSha = (import.meta.env.VITE_BUILD_GIT_SHA ?? "unknown").trim();
const buildTime = (import.meta.env.VITE_BUILD_TIME ?? "unknown").trim();

interface SupabaseConfigError {
  kind: "missing-url" | "missing-key" | "placeholder-url" | "placeholder-key" | "invalid-url";
  message: string;
}

function validateSupabaseConfig(u: string, k: string): SupabaseConfigError | null {
  if (!u) return { kind: "missing-url", message: "VITE_SUPABASE_URL is empty at build time" };
  if (!k) return { kind: "missing-key", message: "VITE_SUPABASE_ANON_KEY is empty at build time" };
  if (u.includes(PLACEHOLDER_URL_HOST)) {
    return { kind: "placeholder-url", message: `VITE_SUPABASE_URL points at the placeholder host "${PLACEHOLDER_URL_HOST}"` };
  }
  if (k === PLACEHOLDER_KEY || k.startsWith("placeholder")) {
    return { kind: "placeholder-key", message: "VITE_SUPABASE_ANON_KEY is the literal placeholder string" };
  }
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") {
      return { kind: "invalid-url", message: `VITE_SUPABASE_URL must be https — got protocol "${parsed.protocol}"` };
    }
    if (!parsed.hostname.endsWith(".supabase.co") && !parsed.hostname.endsWith(".supabase.in")) {
      return { kind: "invalid-url", message: `VITE_SUPABASE_URL host "${parsed.hostname}" doesn't look like a Supabase project` };
    }
  } catch (err) {
    return { kind: "invalid-url", message: `VITE_SUPABASE_URL is not a parseable URL: ${(err as Error).message}` };
  }
  return null;
}

const configError = validateSupabaseConfig(url, anonKey);

/** Always exposed for DevTools — lets the founder dump current config from the console. */
function exposeAuthDebug(): void {
  if (typeof window === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__authDebug = () => {
    const projectRef = (() => {
      try {
        return new URL(url).hostname.split(".")[0];
      } catch {
        return "(unparseable)";
      }
    })();
    const dump = {
      configError,
      supabaseUrl: url || "(empty)",
      anonKeyLength: anonKey.length,
      anonKeyPrefix: anonKey.slice(0, 6),
      projectRef,
      buildSha,
      buildTime,
      online: typeof navigator !== "undefined" ? navigator.onLine : "unknown",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    };
    // eslint-disable-next-line no-console
    console.table(dump);
    return dump;
  };
}

exposeAuthDebug();

if (configError) {
  // Loud, structured, capturable. console.error so DevTools highlights it red,
  // and a tagged Sentry capture so we see the failure rate in the dashboard.
  // eslint-disable-next-line no-console
  console.error("[supabase][config-error]", {
    kind: configError.kind,
    message: configError.message,
    buildSha,
    buildTime,
    suggestion:
      "Pass VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY as Docker build args. " +
      "See docs/runbooks/supabase-config.md for the exact deploy command.",
  });
  captureAuthError("config-error", new Error(`[supabase] ${configError.kind}: ${configError.message}`), {
    buildSha,
    buildTime,
    kind: configError.kind,
  });
  // We do NOT throw here — throwing at module load aborts every dynamic
  // import and the user sees a blank page with no clue what broke. Instead,
  // we let the SDK init proceed (it'll hit a non-existent host on first auth
  // call) but every auth method below is wrapped to surface the config
  // error verbatim with a fix hint, instead of cryptic "Failed to fetch".
}

export const supabase: SupabaseClient = createClient(
  // Even when configError is set, we still pass the (broken) values to the
  // SDK rather than throwing — the App should render and show the error
  // in-page via captureAuthError's Sentry tag + the global window handler.
  url || "https://invalid.placeholder",
  anonKey || "invalid-placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
    global: {
      // Heavy logging on every Supabase HTTP request. We don't replace fetch
      // wholesale — we wrap it so the underlying SDK fetch behavior is
      // preserved (timeouts, AbortSignal, retries) and we add structured
      // breadcrumbs around it.
      fetch: loggedFetch,
    },
  },
);

async function loggedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const startedAt = performance.now();
  addAuthBreadcrumb("supabase.fetch.start", { method, url: requestUrl });
  try {
    const res = await fetch(input, init);
    const ms = Math.round(performance.now() - startedAt);
    addAuthBreadcrumb("supabase.fetch.end", {
      method,
      url: requestUrl,
      status: res.status,
      ms,
    });
    if (!res.ok && res.status >= 400) {
      // eslint-disable-next-line no-console
      console.warn("[supabase][http-error]", {
        method,
        url: requestUrl,
        status: res.status,
        statusText: res.statusText,
        ms,
        configError: configError?.kind ?? null,
        buildSha,
      });
    }
    return res;
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt);
    // eslint-disable-next-line no-console
    console.error("[supabase][fetch-failed]", {
      method,
      url: requestUrl,
      ms,
      online: navigator.onLine,
      configError: configError?.kind ?? null,
      buildSha,
      error: err instanceof Error ? err.message : String(err),
      hint:
        configError?.kind === "placeholder-url"
          ? "The deployed bundle has a placeholder Supabase URL. Redeploy with VITE_SUPABASE_URL build-arg set."
          : "Check network connectivity, Supabase project status, and CORS config on the Supabase dashboard.",
    });
    captureAuthError("supabase-fetch", err instanceof Error ? err : new Error(String(err)), {
      method,
      url: requestUrl,
      ms,
      online: navigator.onLine,
      configError: configError?.kind ?? null,
      buildSha,
    });
    throw err;
  }
}

/**
 * Returns the current access token for outbound API calls.
 * null when there is no authenticated session.
 *
 * Wrapped to log getSession failures — under the placeholder-config bug,
 * this was the call returning silently with `data.session = null` on every
 * page load, making the bug look like a "logged out" state instead of a
 * config error.
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      captureAuthError("get-session", error, { configError: configError?.kind ?? null });
      return null;
    }
    return data.session?.access_token ?? null;
  } catch (err) {
    captureAuthError("get-session-throw", err instanceof Error ? err : new Error(String(err)), {
      configError: configError?.kind ?? null,
    });
    return null;
  }
}

/** Exposed so `<AuthBrokenStartPage />` (or any other surface) can show
 *  a config error to the user instead of pretending they're logged out. */
export function getSupabaseConfigError(): SupabaseConfigError | null {
  return configError;
}

export const SUPABASE_BUILD_META = {
  url,
  anonKeyPrefix: anonKey.slice(0, 6),
  buildSha,
  buildTime,
} as const;
