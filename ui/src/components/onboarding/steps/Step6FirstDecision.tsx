import { cn } from "@/lib/utils";
import {
  type AgentCharterMap,
  type FirstDecisionCard,
} from "../onboarding-types.js";

interface Props {
  decisions: FirstDecisionCard[];
  charters: AgentCharterMap;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function Step6FirstDecision({
  decisions,
  charters,
  selectedId,
  onSelect,
}: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Your first decision
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your CoS has already drafted three experiments based on what you
          picked. Pick one to land in the Decision Inbox pre-approved — the
          matching agent starts working on it immediately. Or skip.
        </p>
      </div>

      <div className="space-y-2">
        {decisions.map((d) => {
          const owner = charters[d.slot];
          const active = selectedId === d.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelect(active ? null : d.id)}
              className={cn(
                "w-full text-left rounded-md border px-4 py-3.5 transition-colors",
                active
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/40",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{d.title}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    {d.rationale}
                  </p>
                </div>
                <div className="shrink-0 rounded-md bg-muted/40 px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {owner.title}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-md border border-dashed border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Prefer to think about it? Skip — you can start any experiment from
          the dashboard.
        </p>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "rounded-md border border-border px-3 py-1.5 text-xs font-medium",
            selectedId === null ? "bg-accent" : "hover:bg-accent/40",
          )}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
