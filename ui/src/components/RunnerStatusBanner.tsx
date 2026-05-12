/**
 * Persistent app-shell banner — visible on every authenticated page when the
 * founder's local runner is not connected. Closes audit P0 #4.
 *
 * The page-level RunnerStatusPill (Agents page) is invisible everywhere else.
 * A founder hitting Today / Inbox / Goals with an offline runner sees nothing
 * wrong but agents are silently idle. This banner surfaces the gap globally.
 *
 * Visibility rules:
 *   1. Never connected — no runner token has ever authenticated. First-time
 *      post-onboarding founder who hasn't started the runner yet.
 *   2. Was connected, now offline — at least one token has `lastSeenAt` but no
 *      token is currently online (lastSeenAt < 30 s). Only fires within a
 *      RECENT_OFFLINE_WINDOW_MS window so long-abandoned installs stay quiet.
 *
 * Mounted in App.tsx above the main route output so it appears on every
 * authenticated page until the runner connects.
 *
 * Polls `/api/companies/:id/runner-status` every 30 s (same React Query key
 * as RunnerStatusPill — no extra network requests when both are on-screen).
 *
 * Dismissible per session with 24 h localStorage TTL.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { runnerApi, type RunnerTokenSummary } from "../api/runner";
import { useCompany } from "../context/CompanyContext";
import { useSupabaseAuth } from "../context/SupabaseAuthContext";
import { RunnerInstallDialog } from "./RunnerInstallDialog";

const POLL_INTERVAL_MS = 30_000;
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Window within which "no online tokens but lastSeenAt set" is treated as
 * "runner went offline" rather than "long-abandoned install". Past this
 * window the banner stays quiet — no point telling a founder their runner
 * went offline weeks ago.
 */
const RECENT_OFFLINE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export type RunnerStatusBannerState =
  | { kind: "hidden" }
  | { kind: "never-connected" }
  | { kind: "offline"; lastSeenAt: string };

/**
 * Pure classifier — exported so tests can exercise it directly without
 * mounting the component.
 */
export function classifyRunnerBannerState(
  tokens: RunnerTokenSummary[] | undefined,
  now: number = Date.now(),
): RunnerStatusBannerState {
  if (!tokens) return { kind: "hidden" };

  // At least one online token → runner is healthy, hide the banner.
  if (tokens.some((t) => t.online)) return { kind: "hidden" };

  const everSeen = tokens
    .map((t) => t.lastSeenAt)
    .filter((v): v is string => Boolean(v));

  // No token has ever authenticated → never connected.
  if (everSeen.length === 0) return { kind: "never-connected" };

  // Has at least one historical lastSeenAt — pick the most recent.
  const mostRecent = everSeen
    .map((iso) => ({ iso, ms: new Date(iso).getTime() }))
    .filter((v) => Number.isFinite(v.ms))
    .sort((a, b) => b.ms - a.ms)[0];

  if (!mostRecent) return { kind: "hidden" };
  // Outside the recent window → long-abandoned install; stay quiet.
  if (now - mostRecent.ms > RECENT_OFFLINE_WINDOW_MS) return { kind: "hidden" };

  return { kind: "offline", lastSeenAt: mostRecent.iso };
}

// ── Dismissal helpers ─────────────────────────────────────────────────────────

interface DismissalRecord {
  dismissedAt: number;
}

function dismissalKey(userId: string | null): string {
  return `founderos_runner_banner_dismissed_at_${userId ?? "anon"}`;
}

function readDismissal(userId: string | null, now: number = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(dismissalKey(userId));
    if (!raw) return false;
    const parsed: DismissalRecord = JSON.parse(raw);
    if (typeof parsed.dismissedAt !== "number") return false;
    if (now - parsed.dismissedAt > DISMISS_TTL_MS) {
      window.localStorage.removeItem(dismissalKey(userId));
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
    window.localStorage.setItem(dismissalKey(userId), JSON.stringify(record));
  } catch {
    // localStorage failure in private mode / quota: non-fatal; banner may
    // re-appear on next render.
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface RunnerStatusBannerProps {
  /** Test seam — overrides companyId from context. */
  companyIdOverride?: string | null;
  /** Test seam — overrides userId used for the dismissal key. */
  userIdOverride?: string | null;
}

export function RunnerStatusBanner({
  companyIdOverride,
  userIdOverride,
}: RunnerStatusBannerProps = {}) {
  const company = useCompany();
  const auth = useSupabaseAuth();
  const companyId = companyIdOverride ?? company.selectedCompanyId ?? null;
  const userId = userIdOverride ?? auth.user?.id ?? null;

  const [dismissedTick, setDismissedTick] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);

  const isDismissed = useMemo(
    () => readDismissal(userId),
    // Re-evaluate when the user clicks dismiss (dismissedTick) or userId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, dismissedTick],
  );

  // Re-show banner automatically after the 24 h TTL without requiring a reload.
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
    () => classifyRunnerBannerState(data?.tokens),
    [data?.tokens],
  );

  const handleDismiss = useCallback(() => {
    writeDismissal(userId);
    setDismissedTick((n) => n + 1);
  }, [userId]);

  if (!companyId) return null;
  if (isDismissed) return null;
  if (state.kind === "hidden") return null;

  return (
    <>
      <div
        role="alert"
        aria-live="assertive"
        data-testid="runner-status-banner"
        className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
      >
        <div className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Terminal className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 text-sm">
              {state.kind === "never-connected" ? (
                <span data-testid="runner-status-banner-message-never">
                  Your local runner isn&apos;t connected yet. Open Claude Code to run your agents.
                </span>
              ) : (
                <span data-testid="runner-status-banner-message-offline">
                  Your local runner is offline. Open Claude Code to run your agents.
                </span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
            <button
              type="button"
              onClick={() => setInstallOpen(true)}
              data-testid="runner-status-banner-cta"
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-900/20 bg-amber-900/5 px-3 py-1.5 hover:bg-amber-900/10 dark:border-amber-100/20 dark:bg-amber-100/5 dark:hover:bg-amber-100/10"
            >
              Get install command
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              data-testid="runner-status-banner-dismiss"
              aria-label="Dismiss runner status banner"
              className="rounded-full px-2 py-1.5 text-amber-900/70 hover:bg-amber-900/10 dark:text-amber-100/70 dark:hover:bg-amber-100/10"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>

      {companyId && (
        <RunnerInstallDialog
          open={installOpen}
          onOpenChange={setInstallOpen}
          companyId={companyId}
        />
      )}
    </>
  );
}
