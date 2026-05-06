import { useQuery } from "@tanstack/react-query";
import { Sparkles, Clock, CheckCircle2 } from "lucide-react";
import {
  templateRegistryApi,
  type NamedTemplate,
} from "../api/template-registry";
import { cn } from "../lib/utils";

/**
 * Template gallery (S6.5) — renders the named PRD-flagship workflow
 * templates as cards. Live templates are clickable (call back to the
 * caller's onAdopt handler with the template's instantiateAs value);
 * v1.1-planned templates render as "Coming soon" with no action.
 *
 * Optionally filtered to a single department via `filterDepartment`.
 */
export function TemplateGallery({
  filterDepartment,
  onAdopt,
}: {
  filterDepartment?: string;
  onAdopt?: (template: NamedTemplate) => void;
}) {
  const registryQuery = useQuery({
    queryKey: ["template-registry"],
    queryFn: () => templateRegistryApi.list(),
  });

  if (registryQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading templates…</p>;
  }
  if (!registryQuery.data) return null;

  const templates = filterDepartment
    ? registryQuery.data.templates.filter(
        (t) => t.department === filterDepartment,
      )
    : registryQuery.data.templates;

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No flagship templates for this department yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {templates.map((t) => (
        <TemplateCard key={t.id} template={t} onAdopt={onAdopt} />
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  onAdopt,
}: {
  template: NamedTemplate;
  onAdopt?: (template: NamedTemplate) => void;
}) {
  const isLive = template.status === "live";
  const clickable = isLive && onAdopt;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 transition-colors",
        clickable && "hover:border-primary cursor-pointer",
        !isLive && "opacity-60",
      )}
      onClick={clickable ? () => onAdopt(template) : undefined}
      role={clickable ? "button" : undefined}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          {template.displayName}
        </h3>
        <StatusBadge status={template.status} />
      </div>

      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        {template.department}
      </div>

      <div className="space-y-1.5 text-[12px] text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Triggers when</span>{" "}
          {template.triggerSummary}
        </div>
        <div>
          <span className="font-medium text-foreground">Then</span>{" "}
          {template.outcomeSummary}
        </div>
      </div>

      <div className="mt-3 text-[11px] text-muted-foreground border-t border-border pt-2">
        Default autonomy: L{template.defaultAutonomy}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: NamedTemplate["status"] }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-300 border border-emerald-300/30">
        <CheckCircle2 className="size-3" />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground border border-border">
      <Clock className="size-3" />
      Coming soon
    </span>
  );
}
