/**
 * App-shell-level banner that surfaces runner-liveness across every
 * authenticated route — NOT just `/agents`. Audit P0.4 (supplementary).
 *
 * The page-level `<RunnerStatusPill />` (Agents.tsx) is fine for "I'm on
 * the team page, what's my runner doing?" but it's invisible everywhere
 * else. A founder hitting Inbox, Goals, Costs etc. with an offline
 * runner has no idea why nothing is moving — agents won't run, but the
 * UI is silent. This banner closes that gap.
 *
 * Visibility rules (only renders when one is true):
 *   1. Runner has NEVER connected — `tokens.length === 0` OR every
 *      token has `lastSeenAt === null`. Implies first-time founder
 *      post-onboarding who hasn't started the daemon yet.
 *   2. Runner WAS connected (some token has `lastSeenAt`) but no
 *      token is currently `online`, AND the most recent contact was
 *      within ~30 minutes (so we know they DID set it up — we're not
 *      reverse-classifying long-abandoned installs as "went offline").
 *
 * Hidden silently when the runner is online or when the user has
 * dismissed (4h TTL via localStorage).
 *
 * Polls `/api/companies/:id/runner-status` every 10s — same query key
 * as `RunnerStatusPill`, so React Query dedupes the network calls.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { runnerApi, type RunnerTokenSummary } from "../api/runner";
import { useCompany } from "../context/CompanyContext";
import { useSupabaseAuth } from "../context/SupabaseAuthContext";

const POLL_INTERVAL_MS = 10_000;
const DISMISS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
/**
 * Window in which "no online tokens but lastSeenAt set" is interpreted
 * as "runner went offline" rather than "runner abandoned long ago."
 * Past this window, we silently hide the banner — no point telling a
 * founder their runner went offline 3 weeks ago.
 */
const RECENT_OFFLINE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export type AppRunnerBannerState =
  | { kind: "hidden" }
  | { kind: "never-connected" }
  | { kind: "went-offline"; lastSeenAt: string };

/**
 * Internal hook — colocated with the banner. Polls runner status on the
 * same query key as `RunnerStatusPill` so both share a single network
 * request via React Query. Returns the banner state to render.
 */
export function classifyAppRunnerState(
  tokens: RunnerTokenSummary[] | undefined,
  now: number = Date.now(),
): AppRunnerBannerState {
  if (!tokens) return { kind: "hidden" };

  // Anyone online → hidden. Founder is healthy, nothing to flag.
  if (tokens.some((t) => t.online)) return { kind: "hidden" };

  // No tokens at all, or no token has ever pinged → never connected.
  const everSeen = tokens
    .map((t) => t.lastSeenAt)
    .filter((v): v is string => Boolean(v));
  if (everSeen.length === 0) return { kind: "never-connected" };

  // At least one token saw a heartbeat in history — sort by lastSeenAt
  // descending and pick the most recent. If recent (< 30 min), surface
  // "went offline." Otherwise the install is dormant; stay quiet.
  const mostRecent = everSeen
    .map((iso) => ({ iso, ms: new Date(iso).getTime() }))
    .filter((v) => Number.isFinite(v.ms))
    .sort((a, b) => b.ms - a.ms)[0];

  if (!mostRecent) return { kind: "hidden" };
  if (now - mostRecent.ms > RECENT_OFFLINE_WINDOW_MS) {
    return { kind: "hidden" };
  }
  return { kind: "went-offline", lastSeenAt: mostRecent.iso };
}

interface DismissalRecord {
  dismissedAt: number;
}

function dismissalStorageKey(userId: string | null): string {
  return `runner-banner-dismissed-${userId ?? "anonymous"}`;
}

function readDismissal(userId: string | null, now: number = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(dismissalStorageKey(userId));
    if (!raw) return false;
    const parsed: DismissalRecord = JSON.parse(raw);
    if (typeof parsed.dismissedAt !== "number") return false;
    if (now - parsed.dismissedAt > DISMISS_TTL_MS) {
      // Expired — clear it so the banner re-appears.
      window.localStorage.removeItem(dismissalStorageKey(userId));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeDismissal(userId: string | null, now: number = Date.now()): void {
  if (typeof window === "undefined") return;
  try {
    const record: DismissalRecord = { dismissedAt: now };
    window.localStorage.setItem(dismissalStorageKey(userId), JSON.stringify(record));
  } catch {
    // Ignore storage failures (private mode, quota, etc.). Worst case the
    // founder sees the banner again on next render — non-fatal.
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown time";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export interface AppRunnerBannerProps {
  /**
   * Override the company id (test seam). Defaults to the company selected
   * via `useCompany()`.
   */
  companyIdOverride?: string | null;
  /**
   * Override the user id used for the dismissal localStorage key (test seam).
   */
  userIdOverride?: string | null;
}

export function AppRunnerBanner({
  companyIdOverride,
  userIdOverride,
}: AppRunnerBannerProps = {}) {
  const company = useCompany();
  const auth = useSupabaseAuth();
  const companyId = companyIdOverride ?? company.selectedCompanyId ?? null;
  const userId = userIdOverride ?? auth.user?.id ?? null;

  const [dismissedTick, setDismissedTick] = useState(0);
  const isDismissed = useMemo(
    () => readDismissal(userId),
    // dismissedTick forces re-evaluation after the user clicks dismiss.
    // userId change also forces re-evaluation (different localStorage key).
    [userId, dismissedTick],
  );

  // Re-check dismissal after the TTL expires so the banner re-appears
  // without requiring a page reload. setTimeout pinned to TTL is cheap;
  // we only schedule it when a dismissal record exists.
  useEffect(() => {
    if (!isDismissed) return;
    const t = setTimeout(() => setDismissedTick((n) => n + 1), DISMISS_TTL_MS);
    return () => clearTimeout(t);
  }, [isDismissed]);

  const { data } = useQuery({
    queryKey: ["runner-status", companyId],
    queryFn: () => runnerApi.status(companyId as string),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_INTERVAL_MS / 2,
    enabled: Boolean(companyId),
  });

  const state = useMemo(
    () => classifyAppRunnerState(data?.tokens),
    [data?.tokens],
  );

  const handleDismiss = useCallback(() => {
    writeDismissal(userId);
    setDismissedTick((n) => n + 1);
  }, [userId]);

  if (!companyId) return null;
  if (isDismissed) return null;
  if (state.kind === "hidden") return null;

  // Deep-link to Agents page with the install dialog auto-opened
  // (Agents.tsx consumes the query param + strips it on mount).
  // 2026-05-18 — replaces the plain "/agents/all" link that landed the
  // founder on the team page with no obvious next step. Now the modal
  // pops directly so the founder can issue a token + copy the install
  // command in one click.
  const setupHref = "/agents/all?install-runner=1";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="app-runner-banner"
      className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            {state.kind === "never-connected" ? (
              <span data-testid="app-runner-banner-message-never">
                Your runner isn't set up yet — agents won't run until you start it.
              </span>
            ) : (
              <span data-testid="app-runner-banner-message-offline">
                Your runner went offline at {formatTime(state.lastSeenAt)} — restart it to resume agent work.
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          <a
            href={setupHref}
            data-testid="app-runner-banner-cta"
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-900/20 bg-amber-900/5 px-3 py-1.5 hover:bg-amber-900/10 dark:border-amber-100/20 dark:bg-amber-100/5 dark:hover:bg-amber-100/10"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            <span>
              {state.kind === "never-connected" ? "Get setup instructions" : "Reconnect"}
            </span>
          </a>
          <button
            type="button"
            onClick={handleDismiss}
            data-testid="app-runner-banner-dismiss"
            aria-label="Dismiss runner banner"
            className="rounded-full px-2 py-1.5 text-amber-900/70 hover:bg-amber-900/10 dark:text-amber-100/70 dark:hover:bg-amber-100/10"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
