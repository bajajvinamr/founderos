import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_LABELS,
  NON_CORE_DEPARTMENTS,
  NON_CORE_DEPARTMENT_DESCRIPTIONS,
  NON_CORE_DEPARTMENT_LABELS,
  type AutonomyLevel,
  type NonCoreDepartmentId,
} from "../onboarding-types.js";

interface Props {
  nonCoreDepartments: NonCoreDepartmentId[];
  autonomyLevel: AutonomyLevel;
  onNonCoreDepartmentsChange: (next: NonCoreDepartmentId[]) => void;
  onAutonomyLevelChange: (next: AutonomyLevel) => void;
}

const CORE_DEPARTMENTS: Array<{ id: string; label: string; description: string }> = [
  { id: "chief-of-staff", label: "Chief of Staff", description: "Priorities, brief, capital allocation" },
  { id: "growth", label: "Growth", description: "Acquisition, experiments, channels" },
  { id: "content", label: "Content Studio", description: "Research, drafts, distribution, attribution" },
  { id: "crm", label: "CRM & Lifecycle", description: "Onboarding, activation, churn, upsell" },
  { id: "finance", label: "Finance", description: "Revenue, pricing, runway, burn" },
];

export function Step5Departments({
  nonCoreDepartments,
  autonomyLevel,
  onNonCoreDepartmentsChange,
  onAutonomyLevelChange,
}: Props) {
  function toggleNonCore(id: NonCoreDepartmentId) {
    const next = nonCoreDepartments.includes(id)
      ? nonCoreDepartments.filter((d) => d !== id)
      : [...nonCoreDepartments, id];
    onNonCoreDepartmentsChange(next);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Pick your departments.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The five core departments are always on — they're the wedge of
          the product. Engineering and Operations are opt-in; turn them on
          if you'll route work there.
        </p>
      </div>

      <section aria-labelledby="core-heading" className="space-y-3">
        <h3 id="core-heading" className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Core · Always on
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {CORE_DEPARTMENTS.map((d) => (
            <div
              key={d.id}
              className="flex items-start gap-3 rounded-md border border-border bg-card px-3.5 py-3"
            >
              <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{d.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {d.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="optional-heading" className="space-y-3">
        <h3 id="optional-heading" className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Optional · Toggle on if you need them
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {NON_CORE_DEPARTMENTS.map((id) => {
            const active = nonCoreDepartments.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleNonCore(id)}
                className={cn(
                  "text-left rounded-md border px-3.5 py-3 transition-colors",
                  active
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <p className="text-sm font-medium">
                  {NON_CORE_DEPARTMENT_LABELS[id]}
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                  {NON_CORE_DEPARTMENT_DESCRIPTIONS[id]}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="autonomy-heading" className="space-y-3">
        <h3 id="autonomy-heading" className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Autonomy
        </h3>
        <p className="text-xs text-muted-foreground -mt-1">
          How much can your agents do without you? You can change this
          per-department later.
        </p>
        <div className="flex flex-col gap-2">
          {AUTONOMY_LEVELS.map((level) => {
            const active = autonomyLevel === level;
            const meta = AUTONOMY_LEVEL_LABELS[level];
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                onClick={() => onAutonomyLevelChange(level)}
                className={cn(
                  "flex items-center gap-3 text-left rounded-md border px-3.5 py-3 transition-colors",
                  active
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-mono tabular-nums",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {level}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {meta.label}
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-snug">
                    {meta.sublabel}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
