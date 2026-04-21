import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, PenLine } from "lucide-react";
import { agentReviewsApi } from "@/api/agent-reviews";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/api/client";
import type { AgentReview, AgentReviewRecommendation } from "@founderos/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recommendationLabel(rec: AgentReviewRecommendation): string {
  switch (rec) {
    case "promote":
      return "Pulling more than their weight.";
    case "keep":
      return "Doing the job.";
    case "rebrief":
      return "May need clearer direction.";
    case "let_go":
      return "Consider offboarding.";
  }
}

function recommendationDotClass(rec: AgentReviewRecommendation): string {
  switch (rec) {
    case "promote":
      return "bg-emerald-400";
    case "keep":
      return "bg-blue-400";
    case "rebrief":
      return "bg-amber-400";
    case "let_go":
      return "bg-red-400";
  }
}

function monthLabel(monthOf: string): string {
  const d = new Date(`${monthOf}T12:00:00.000Z`);
  return d
    .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

function currentMonthOf(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ---------------------------------------------------------------------------
// Custom review modal
// ---------------------------------------------------------------------------

const RECOMMENDATIONS: AgentReviewRecommendation[] = ["keep", "rebrief", "let_go", "promote"];

function CustomReviewModal({
  open,
  onClose,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    summaryMarkdown: string;
    recommendation: AgentReviewRecommendation;
    rationale: string;
  }) => void;
  isSubmitting: boolean;
}) {
  const [summaryMarkdown, setSummaryMarkdown] = useState("");
  const [recommendation, setRecommendation] = useState<AgentReviewRecommendation>("keep");
  const [rationale, setRationale] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!summaryMarkdown.trim() || !rationale.trim()) return;
    onSubmit({ summaryMarkdown, recommendation, rationale });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Write Custom Review</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Recommendation
            </label>
            <div className="flex flex-wrap gap-2">
              {RECOMMENDATIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRecommendation(r)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                    recommendation === r
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:border-foreground/50",
                  )}
                >
                  {r.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Summary
            </label>
            <textarea
              value={summaryMarkdown}
              onChange={(e) => setSummaryMarkdown(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="3–5 sentences about this teammate's month…"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Rationale (one sentence)
            </label>
            <input
              type="text"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Why this recommendation?"
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save Review
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function MonthlyReviewCard({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: review, isLoading } = useQuery({
    queryKey: queryKeys.agentReviews.latest(agentId),
    queryFn: () =>
      agentReviewsApi.getLatest(companyId, agentId).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    retry: false,
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      agentReviewsApi.generate(companyId, agentId, { monthOf: currentMonthOf() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentReviews.latest(agentId) });
      setError(null);
    },
    onError: () => setError("Failed to generate review. Try again."),
  });

  const manualMutation = useMutation({
    mutationFn: (data: {
      summaryMarkdown: string;
      recommendation: AgentReviewRecommendation;
      rationale: string;
    }) =>
      agentReviewsApi.createManual(companyId, agentId, {
        ...data,
        monthOf: currentMonthOf(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentReviews.latest(agentId) });
      setModalOpen(false);
      setError(null);
    },
    onError: () => setError("Failed to save review. Try again."),
  });

  if (isLoading) {
    return (
      <div className="border border-border rounded-lg p-5 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="h-5 w-48 bg-muted rounded mb-4" />
        <div className="h-3 w-full bg-muted rounded" />
      </div>
    );
  }

  if (!review) {
    return (
      <div className="border border-border rounded-lg p-5">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
          Performance Review
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          No review yet. Generate the first one.
        </p>
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
        <Button
          size="sm"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
        >
          {generateMutation.isPending && (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          )}
          Generate first review
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="border border-border rounded-lg p-5 space-y-4">
        {/* Eyebrow */}
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Performance · {monthLabel(review.monthOf)}
        </div>

        {/* Headline + dot */}
        <div className="flex items-center gap-2.5">
          <span
            className={cn("h-2.5 w-2.5 rounded-full shrink-0", recommendationDotClass(review.recommendation))}
          />
          <h3 className="text-[18px] leading-tight font-semibold">
            {recommendationLabel(review.recommendation)}
          </h3>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-4 gap-3 tabular-nums">
          <div>
            <span className="block text-[11px] text-muted-foreground mb-0.5">Sessions</span>
            <span className="text-base font-semibold">{review.shiftsRun}</span>
          </div>
          <div>
            <span className="block text-[11px] text-muted-foreground mb-0.5">Closed</span>
            <span className="text-base font-semibold">{review.issuesClosed}</span>
          </div>
          <div>
            <span className="block text-[11px] text-muted-foreground mb-0.5">Spent</span>
            <span className="text-base font-semibold">{formatCents(review.costCents)}</span>
          </div>
          <div>
            <span className="block text-[11px] text-muted-foreground mb-0.5">Blocked</span>
            <span className="text-base font-semibold">{review.blockedIncidents}</span>
          </div>
        </div>

        {/* Summary body */}
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
          {review.summaryMarkdown}
        </p>

        {/* Rationale */}
        <p className="text-xs text-muted-foreground italic">{review.rationale}</p>

        {/* Action row */}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Generate fresh review
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setModalOpen(true)}
          >
            <PenLine className="h-3.5 w-3.5 mr-1.5" />
            Write custom review
          </Button>
        </div>
      </div>

      <CustomReviewModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={(data) => manualMutation.mutate(data)}
        isSubmitting={manualMutation.isPending}
      />
    </>
  );
}
