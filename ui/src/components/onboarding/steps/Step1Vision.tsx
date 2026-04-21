import { useMemo } from "react";

interface ExampleCard {
  id: string;
  label: string;
  body: string;
  prefill: string;
}

const EXAMPLES: ExampleCard[] = [
  {
    id: "indie",
    label: "Indie SaaS",
    body: "A workflow tool for a niche I know cold",
    prefill:
      "A SaaS tool for solo freelancers managing multiple clients. I'm bootstrapping it myself, aiming for $10K MRR before I think about anything else.",
  },
  {
    id: "b2b_ai",
    label: "B2B AI",
    body: "An AI product for a specific vertical",
    prefill:
      "A B2B AI product that drafts compliance reports for mid-size healthcare ops teams. Pre-seed, targeting first 5 design partners.",
  },
  {
    id: "consumer",
    label: "Consumer mobile",
    body: "A mobile app for real humans",
    prefill:
      "A mobile app that helps parents track their kids' developmental milestones for Indian schools. Starts as a school-facing tool, goes direct to parents in v2.",
  },
];

interface Props {
  vision: string;
  onVisionChange: (next: string) => void;
}

export function Step1Vision({ vision, onVisionChange }: Props) {
  const trimmedLen = useMemo(() => vision.trim().length, [vision]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          What are you building?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          One paragraph. What the product is, who it's for, where you are.
          Your Chief of Staff reads this first — it seeds every agent.
        </p>
      </div>

      <textarea
        className="w-full min-h-[180px] rounded-md border border-border bg-transparent px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-y"
        placeholder="e.g. a mobile app that helps parents track their kids' developmental milestones for Indian schools."
        value={vision}
        onChange={(e) => onVisionChange(e.target.value)}
        autoFocus
      />

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Or start from an example
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              type="button"
              onClick={() => onVisionChange(ex.prefill)}
              className="text-left rounded-md border border-border bg-transparent px-3 py-2.5 hover:bg-accent/40 transition-colors"
            >
              <p className="text-sm font-medium">{ex.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                {ex.body}
              </p>
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {trimmedLen > 0
          ? `${trimmedLen} characters — good. More detail = sharper agents.`
          : "Write at least a sentence so we can seed the team."}
      </p>
    </div>
  );
}
