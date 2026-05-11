/**
 * FounderOS feature flags — UI-side resolution.
 *
 * Wave 1 introduces `FOUNDEROS_ASK_FIRST_SHELL` which gates the Ask-First
 * shell (AskBar + 5-section sidebar + Today hero). Per the engineering
 * handoff (06-engineering-handoff.md §2.4) and red-team F-04 fold:
 *
 * - Default OFF for new instances.
 * - Default ON for Vinamr's instance from the merge commit.
 * - Other instances opt in via the `FOUNDEROS_ASK_FIRST_SHELL=true` env var
 *   (build-time, via `VITE_FOUNDEROS_ASK_FIRST_SHELL`) or per-user toggle
 *   via the `?shell=new` query param.
 *
 * Rollback: set the env var to `false` (or unset the query param). Legacy
 * shell renders unchanged. No data migrations are involved.
 */

/**
 * Read once from the URL on each evaluation so the toggle works for tests
 * and for founders who paste `?shell=new` into their address bar.
 */
function readQueryParamOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("shell");
    if (value === "new") return true;
    if (value === "legacy") return false;
    return null;
  } catch {
    return null;
  }
}

function readEnvOverride(): boolean | null {
  const raw = import.meta.env.VITE_FOUNDEROS_ASK_FIRST_SHELL;
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

/**
 * Resolve whether the new Ask-First shell renders for the current user.
 *
 * @param ctx Resolution context (instanceId is reserved for Wave 2+
 *            once we have a server-side allowlist; in Wave 1 the
 *            env-var / query-param overrides are sufficient).
 */
export interface AskFirstShellContext {
  /** Optional — Wave 2 will use this for the Vinamr-instance allowlist. */
  instanceId?: string | null;
}

export function isAskFirstShellEnabled(_ctx: AskFirstShellContext = {}): boolean {
  // 1. Query param override (highest priority — lets founders toggle in URL).
  const queryOverride = readQueryParamOverride();
  if (queryOverride !== null) return queryOverride;

  // 2. Build-time env var (set per deployment).
  const envOverride = readEnvOverride();
  if (envOverride !== null) return envOverride;

  // 3. Default OFF for Wave 1. Wave 2 wires the Vinamr-instance allowlist
  //    against ctx.instanceId.
  return false;
}

/**
 * Stable feature flag key for telemetry / settings UI references.
 */
export const FOUNDEROS_ASK_FIRST_SHELL_KEY = "FOUNDEROS_ASK_FIRST_SHELL";
