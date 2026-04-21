import { cn } from "@/lib/utils";
import {
  BOTTLENECKS,
  BOTTLENECK_LABELS,
  type Bottleneck,
} from "../onboarding-types.js";

interface Props {
  selected: Bottleneck[];
  onChange: (next: Bottleneck[]) => void;
}

const DESCRIPTIONS: Record<Bottleneck, string> = {
  hiring: "Finding, closing, onboarding the right people.",
  growth: "Getting more of the right users through the door.",
  content: "Shipping writing on a predictable cadence.",
  finance: "Runway, burn, vendor spend, clean numbers.",
  ops: "Repeated work that eats the founder's week.",
  fundraising: "Angels, seed, Series A — pipeline and narrative.",
  pmf: "Is anyone actually pulling? What do they pull on?",
};

const MAX_SELECTIONS = 2;

export function Step2Bottleneck({ selected, onChange }: Props) {
  function toggle(b: Bottleneck) {
    if (selected.includes(b)) {
      onChange(selected.filter((x) => x !== b));
      return;
    }
    if (selected.length >= MAX_SELECTIONS) {
      // Replace the oldest.
      onChange([selected[selected.length - 1]!, b]);
      return;
    }
    onChange([...selected, b]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          What's the hardest part right now?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick 1 or 2. This tells the CoS which department to lean on first —
          every agent gets briefed around this.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {BOTTLENECKS.map((b) => {
          const active = selected.includes(b);
          return (
            <button
              key={b}
              type="button"
              onClick={() => toggle(b)}
              className={cn(
                "text-left rounded-md border px-3.5 py-3 transition-colors",
                active
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/40",
              )}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{BOTTLENECK_LABELS[b]}</p>
                {active && (
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    {selected.indexOf(b) === 0 ? "PRIMARY" : "SECONDARY"}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                {DESCRIPTIONS[b]}
              </p>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? "Pick at least one to continue."
          : selected.length === 1
            ? "Add a second (optional) or continue."
            : "Two selected — first one is primary."}
      </p>
    </div>
  );
}
