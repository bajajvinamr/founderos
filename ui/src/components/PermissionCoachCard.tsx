import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { permissionCoachApi } from "@/api/permission-coach";
import type { PermissionCoachRecommendation } from "@founderos/shared";

interface PermissionCoachCardProps {
  companyId: string;
}

const PERMISSION_LABELS: Record<string, string> = {
  observe: "Observe",
  suggest: "Suggest",
  approve: "Approve",
  autonomous: "Autonomous",
};

const SNOOZE_KEY = (companyId: string, agentId: string) =>
  `permission-coach-snooze-${companyId}-${agentId}`;

function isSnoozed(companyId: string, agentId: string): boolean {
  const key = SNOOZE_KEY(companyId, agentId);
  const snoozedUntil = localStorage.getItem(key);
  if (!snoozedUntil) return false;

  const until = new Date(snoozedUntil).getTime();
  const now = new Date().getTime();
  return now < until;
}

function snoozeFor7Days(companyId: string, agentId: string) {
  const key = SNOOZE_KEY(companyId, agentId);
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  localStorage.setItem(key, sevenDaysFromNow.toISOString());
}

export function PermissionCoachCard({ companyId }: PermissionCoachCardProps) {
  const queryClient = useQueryClient();
  const [visibleCount, setVisibleCount] = useState(3);

  const { data: response, isLoading } = useQuery({
    queryKey: queryKeys.permissionCoach(companyId),
    queryFn: () => permissionCoachApi.getRecommendations(companyId),
    enabled: !!companyId,
  });

  const applyMutation = useMutation({
    mutationFn: ({
      agentId,
      targetLevel,
    }: {
      agentId: string;
      targetLevel: string;
    }) => permissionCoachApi.applyChange(companyId, agentId, targetLevel),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.permissionCoach(companyId),
      });
    },
  });

  const recommendations = (response?.recommendations ?? []).filter(
    (rec) => !isSnoozed(companyId, rec.agentId),
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading recommendations...</p>
        </div>
      </div>
    );
  }

  if (!recommendations || recommendations.length === 0) {
    return null;
  }

  const visibleRecs = recommendations.slice(0, visibleCount);
  const hasMore = recommendations.length > visibleCount;

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          Autonomy Coaching
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Your agents are ready for more responsibility
        </p>
      </div>

      <div className="space-y-3">
        {visibleRecs.map((rec) => (
          <div
            key={rec.agentId}
            className="flex items-start justify-between gap-3 rounded-md border border-border/50 bg-accent/40 p-3"
          >
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-foreground">
                  {rec.agentName}
                </p>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[11px] font-medium">
                    {PERMISSION_LABELS[rec.currentLevel] || rec.currentLevel}
                  </span>
                  <ChevronRight className="h-3 w-3" />
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium">
                    {rec.targetLevel ? PERMISSION_LABELS[rec.targetLevel] || rec.targetLevel : rec.currentLevel}
                  </span>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                You approved {rec.approvedCount} of {rec.approvedCount + rec.rejectedCount} of{" "}
                {rec.agentName}'s actions last month ({Math.round(rec.rate * 100)}% approval rate)
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  snoozeFor7Days(companyId, rec.agentId);
                  // Refetch to filter out snoozed items
                  window.location.reload();
                }}
                className="px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Snooze
              </button>
              <Button
                size="sm"
                variant="default"
                disabled={applyMutation.isPending}
                onClick={() => {
                  if (rec.targetLevel) {
                    applyMutation.mutate({
                      agentId: rec.agentId,
                      targetLevel: rec.targetLevel,
                    });
                  }
                }}
                className="gap-1"
              >
                {applyMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
                Accept
              </Button>
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setVisibleCount((prev) => prev + 3)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Show {Math.min(3, recommendations.length - visibleCount)} more recommendations
        </button>
      )}
    </div>
  );
}
