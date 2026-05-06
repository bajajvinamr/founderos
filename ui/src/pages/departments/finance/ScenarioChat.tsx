import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { financeApi, type ScenarioRunResult } from "@/api/finance";
import { cn } from "../../../lib/utils";

/**
 * Scenario modeling (S5.4) — natural-language "what-if" interface.
 *
 * Founder types a question in plain English ("what happens if I
 * reduce free credits by 70%?") and Claude orchestrates the existing
 * finance services (cockpit, churn, runway, pricing-sim, cash-plan)
 * as tools, returning a structured answer with key numbers, narrative,
 * and warnings.
 *
 * UX choice — each ask is independent (no chat history) so the founder
 * can iterate quickly without conversation-state confusion. The same
 * question always returns a deterministic-ish answer because tool
 * outputs are pulled fresh from the DB.
 */
export function ScenarioChat({ companyId }: { companyId: string }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ScenarioRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (q: string) => financeApi.scenario(companyId, q),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      setResult(null);
    },
  });

  function ask() {
    const trimmed = question.trim();
    if (trimmed.length < 8) return;
    mutation.mutate(trimmed);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" />
          Ask a finance scenario
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Plain English. The agent reads your live cockpit, churn curve,
          runway, and cash-plan to compose the answer. Try: "what happens if
          I raise prices 20%?" or "if I hire two engineers at $150k each in
          three months, when does cash run out?"
        </p>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What happens if I reduce free credits by 70%?"
          rows={3}
          className="resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
          }}
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            ⌘/Ctrl + Enter to ask
          </p>
          <Button
            onClick={ask}
            disabled={mutation.isPending || question.trim().length < 8}
            size="sm"
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                Thinking…
              </>
            ) : (
              <>
                Ask
                <ArrowRight className="size-3.5 ml-1.5" />
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 text-destructive" />
            Couldn't run the scenario
          </div>
          <p className="text-xs text-muted-foreground">{error}</p>
          {error.includes("no_anthropic_key") && (
            <p className="text-xs text-muted-foreground">
              Set an Anthropic key under Instance → Providers, then retry.
            </p>
          )}
        </div>
      )}

      {result && <ScenarioResult result={result} />}
    </div>
  );
}

function ScenarioResult({ result }: { result: ScenarioRunResult }) {
  const { response, steps, toolCalls } = result;
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div>
        <h3 className="font-display text-[20px] leading-[1.2] tracking-tight">
          {response.headline}
        </h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {response.narrative}
        </p>
      </div>

      {response.keyNumbers.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {response.keyNumbers.map((kn, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {kn.label}
              </div>
              <div className="text-base font-semibold tabular-nums">
                {kn.value}
              </div>
              {kn.delta && (
                <div
                  className={cn(
                    "text-[11px] tabular-nums",
                    kn.delta.startsWith("-")
                      ? "text-destructive"
                      : kn.delta.startsWith("+")
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground",
                  )}
                >
                  {kn.delta}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {response.warnings.length > 0 && (
        <div className="space-y-1.5">
          {response.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0" />
              <p>{w}</p>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>{steps} step{steps === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>
          {toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}
        </span>
        {response.toolsUsed.length > 0 && (
          <>
            <span>·</span>
            <span>used: {response.toolsUsed.join(", ")}</span>
          </>
        )}
      </div>
    </div>
  );
}
