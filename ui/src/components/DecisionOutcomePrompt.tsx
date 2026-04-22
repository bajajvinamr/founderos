import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { queryKeys } from "../lib/queryKeys";
import {
  decisionOutcomesApi,
  type DecisionOutcomeStatus,
} from "../api/decision-outcomes";

type RecordableStatus = Exclude<DecisionOutcomeStatus, "pending_followup">;

interface DecisionOutcomePromptProps {
  companyId: string;
  approvalId: string;
  /** Called after the outcome is successfully recorded. */
  onRecorded?: () => void;
}

const STATUS_OPTIONS: { value: RecordableStatus; label: string; hint: string }[] = [
  { value: "worked", label: "Worked", hint: "Delivered the intended result" },
  { value: "did_not_work", label: "Did not work", hint: "Didn't land — note the why" },
  { value: "unclear", label: "Unclear", hint: "Too early / can't attribute" },
  { value: "dropped", label: "Dropped", hint: "Never executed / abandoned" },
];

/**
 * Inline "what happened?" form shown on an approved decision ~14 days later.
 * Radio (status) + note + metric delta + submit. Writes the answer, flips the
 * outcome off of pending_followup, and invalidates related query caches.
 */
export function DecisionOutcomePrompt({
  companyId,
  approvalId,
  onRecorded,
}: DecisionOutcomePromptProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RecordableStatus | null>(null);
  const [note, setNote] = useState("");
  const [metric, setMetric] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!status) throw new Error("Pick an outcome status first");
      return decisionOutcomesApi.record(companyId, approvalId, {
        status,
        note: note.trim() || null,
        metric: metric.trim() || null,
      });
    },
    onSuccess: () => {
      setError(null);
      setNote("");
      setMetric("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.decisionOutcomes.forApproval(companyId, approvalId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.decisionOutcomes.pending(companyId),
      });
      onRecorded?.();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to record outcome"),
  });

  return (
    <div className="border border-border rounded-lg p-4 space-y-4 bg-muted/20">
      <div>
        <h3 className="text-sm font-medium">Two weeks later — what happened?</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Close the loop so future decisions have history. Takes 30 seconds.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Outcome
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {STATUS_OPTIONS.map((opt) => {
            const selected = status === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex items-start gap-2 rounded-md border p-2.5 cursor-pointer transition-colors ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/20"
                }`}
              >
                <input
                  type="radio"
                  name={`outcome-status-${approvalId}`}
                  value={opt.value}
                  checked={selected}
                  onChange={() => setStatus(opt.value)}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.hint}</p>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Metric delta <span className="font-normal normal-case">(optional)</span>
        </label>
        <Input
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          placeholder='e.g. "MRR +15%", "closed 3 customers", "churn -2pp"'
          maxLength={500}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Note <span className="font-normal normal-case">(optional)</span>
        </label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What actually happened? Why?"
          rows={3}
          maxLength={8_000}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={!status || mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Record outcome"}
        </Button>
      </div>
    </div>
  );
}
