import { cn } from "@/lib/utils";
import { TEAM_SHAPES, TEAM_SHAPE_LABELS, type TeamShape } from "../onboarding-types.js";

interface Props {
  team: TeamShape;
  cofounderName: string;
  cofounderEmail: string;
  onTeamChange: (next: TeamShape) => void;
  onCofounderNameChange: (next: string) => void;
  onCofounderEmailChange: (next: string) => void;
}

const DESCRIPTIONS: Record<TeamShape, string> = {
  solo: "One human, four agents. CoS talks to you directly, unfiltered.",
  cofounder: "Two humans. CoS routes decisions by who owns what.",
  small_team: "3-5 humans. CoS summarises, you delegate.",
};

export function Step3Team({
  team,
  cofounderName,
  cofounderEmail,
  onTeamChange,
  onCofounderNameChange,
  onCofounderEmailChange,
}: Props) {
  const showCofounderFields = team === "cofounder" || team === "small_team";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Who's on the team?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Shapes how your Chief of Staff communicates. Solo gets direct,
          team gets summarised.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {TEAM_SHAPES.map((opt) => {
          const active = team === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onTeamChange(opt)}
              className={cn(
                "text-left rounded-md border px-3.5 py-3 transition-colors",
                active
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/40",
              )}
            >
              <p className="text-sm font-medium">{TEAM_SHAPE_LABELS[opt]}</p>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                {DESCRIPTIONS[opt]}
              </p>
            </button>
          );
        })}
      </div>

      {showCofounderFields && (
        <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 px-4 py-4">
          <p className="text-xs font-medium">
            Cofounder (optional) — we pre-stage an invite.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Name
              </label>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                placeholder="Cofounder name"
                value={cofounderName}
                onChange={(e) => onCofounderNameChange(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Email
              </label>
              <input
                type="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                placeholder="name@domain.com"
                value={cofounderEmail}
                onChange={(e) => onCofounderEmailChange(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
