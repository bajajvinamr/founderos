/**
 * S3.10 — first-run progress card.
 *
 * Renders only while a magic-activation-gate run is in flight. Polls the
 * server every 2s; when status flips to "done" we fire a single toast
 * ("Your first brief is ready") with a link to /brief and unmount on the
 * next render cycle. Errors render a soft warning row but never block the
 * dashboard — failures in any non-fatal step are already captured in the
 * step list.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { CheckCircle2, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { firstRunApi, type FirstRunProgress } from "../api/firstRun";
import { useToast } from "../context/ToastContext";
import { cn } from "@/lib/utils";

interface FirstRunProgressCardProps {
  companyId: string;
}

const POLL_INTERVAL_MS = 2_000;
const COMPLETED_DISPLAY_MS = 4_000;

export function FirstRunProgressCard({ companyId }: FirstRunProgressCardProps) {
  const { pushToast } = useToast();
  const toastFiredRef = useRef(false);
  const hideAfterCompleteRef = useRef<number | null>(null);

  const { data } = useQuery({
    queryKey: ["first-run-progress", companyId],
    queryFn: () => firstRunApi.getProgress(companyId),
    enabled: !!companyId,
    refetchInterval: (query) => {
      const progress = query.state.data?.progress;
      if (!progress) return POLL_INTERVAL_MS;
      if (progress.status === "running") return POLL_INTERVAL_MS;
      // Stop polling once the run reaches a terminal state.
      return false;
    },
  });

  const progress = data?.progress ?? null;

  // Fire toast exactly once when run completes successfully.
  useEffect(() => {
    if (!progress) return;
    if (progress.status !== "done") return;
    if (toastFiredRef.current) return;
    toastFiredRef.current = true;
    pushToast({
      tone: "success",
      title: "Your first brief is ready",
      body: "FounderOS finished backfilling integrations and generated your first executive brief.",
      action: { label: "Open brief", href: "/brief" },
      ttlMs: 8_000,
      dedupeKey: `first-run-done:${progress.companyId}`,
    });
    hideAfterCompleteRef.current = window.setTimeout(() => {
      hideAfterCompleteRef.current = null;
    }, COMPLETED_DISPLAY_MS);
  }, [progress, pushToast]);

  if (!progress) return null;

  return (
    <div className="rounded-lg border border-purple-300/60 bg-gradient-to-br from-purple-50/80 to-blue-50/80 p-4 dark:border-purple-500/30 dark:from-purple-950/30 dark:to-blue-950/30">
      <div className="flex items-center gap-3">
        {progress.status === "running" ? (
          <Loader2 className="h-5 w-5 animate-spin text-purple-600 dark:text-purple-300" />
        ) : progress.status === "done" ? (
          <Sparkles className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-300" />
        )}
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            {progress.status === "done"
              ? "Your first brief is ready"
              : progress.status === "error"
                ? "We hit an issue while generating your first brief"
                : "Generating your first executive brief…"}
          </p>
          <p className="text-xs text-muted-foreground">
            {progress.completedSteps} / {progress.totalSteps} steps complete
          </p>
        </div>
        {progress.status === "done" && progress.dailyBriefId && (
          <Link
            to="/brief"
            className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
          >
            Open brief
          </Link>
        )}
      </div>
      <ol className="mt-3 space-y-1.5">
        {progress.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2 text-xs">
            <StepIcon status={step.status} />
            <span
              className={cn(
                "truncate",
                step.status === "running" && "text-foreground",
                step.status === "done" && "text-emerald-700 dark:text-emerald-300",
                step.status === "skipped" && "text-muted-foreground",
                step.status === "error" && "text-amber-700 dark:text-amber-300",
                step.status === "pending" && "text-muted-foreground",
              )}
            >
              {step.label}
              {step.error && step.status === "error" ? ` — ${step.error}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepIcon({ status }: { status: FirstRunProgress["steps"][number]["status"] }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />;
  }
  if (status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-600 dark:text-purple-300" />;
  }
  if (status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300" />;
  }
  if (status === "skipped") {
    return <span className="block h-3.5 w-3.5 rounded-full border border-dashed border-muted-foreground" />;
  }
  return <span className="block h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />;
}
