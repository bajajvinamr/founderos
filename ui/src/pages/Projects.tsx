import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import type { Agent, Project } from "@founderos/shared";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatDate, projectUrl, cn } from "../lib/utils";
import { Hexagon, Search, Plus } from "lucide-react";

type SortKey = "name" | "lead" | "target" | "status" | "updated";
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const COLUMN_WIDTHS = {
  name: "min-w-0 flex-1",
  lead: "w-40 shrink-0",
  target: "w-32 shrink-0",
  goals: "w-24 shrink-0",
  status: "w-32 shrink-0",
  updated: "w-32 shrink-0",
} as const;

function compareProjects(
  a: Project,
  b: Project,
  sort: SortState,
  agentsById: Map<string, Agent>,
): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "name":
      return a.name.localeCompare(b.name) * dir;
    case "lead": {
      const aName = a.leadAgentId ? agentsById.get(a.leadAgentId)?.name ?? "" : "";
      const bName = b.leadAgentId ? agentsById.get(b.leadAgentId)?.name ?? "" : "";
      return aName.localeCompare(bName) * dir;
    }
    case "target": {
      const aDate = a.targetDate ? new Date(a.targetDate).getTime() : Number.POSITIVE_INFINITY;
      const bDate = b.targetDate ? new Date(b.targetDate).getTime() : Number.POSITIVE_INFINITY;
      return (aDate - bDate) * dir;
    }
    case "status":
      return a.status.localeCompare(b.status) * dir;
    case "updated":
    default: {
      const aUpd = new Date(a.updatedAt).getTime();
      const bUpd = new Date(b.updatedAt).getTime();
      return (aUpd - bUpd) * dir;
    }
  }
}

interface SortHeaderProps {
  label: string;
  field: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}

function SortHeader({ label, field, sort, onSort, className }: SortHeaderProps) {
  const active = sort.key === field;
  const arrow = active ? (sort.dir === "asc" ? "↑" : "↓") : "";
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide",
        "hover:text-foreground transition-colors",
        className,
      )}
    >
      <span>{label}</span>
      {arrow && <span aria-hidden="true">{arrow}</span>}
    </button>
  );
}

interface ProjectRowProps {
  project: Project;
  agentsById: Map<string, Agent>;
}

/**
 * Project.goalIds is the current field; Project.goals is deprecated (see
 * packages/shared/src/types/project.ts). Prefer goalIds; fall back to goals
 * only when goalIds is absent. `??` (nullish-coalescing) — NOT `||` — so an
 * empty array on the current field does not fall through to the deprecated one.
 */
export function projectGoalCount(project: Pick<Project, "goals" | "goalIds">): number {
  return project.goalIds?.length ?? project.goals?.length ?? 0;
}

function ProjectRow({ project, agentsById }: ProjectRowProps) {
  const leadAgent = project.leadAgentId ? agentsById.get(project.leadAgentId) : null;
  const goalCount = projectGoalCount(project);
  const targetLabel = project.targetDate ? formatDate(project.targetDate) : "—";
  const updatedLabel = formatDate(project.updatedAt);
  const ariaLabel = `Project: ${project.name}, status ${project.status}, due ${targetLabel}`;

  return (
    <Link
      to={projectUrl(project)}
      role="article"
      aria-label={ariaLabel}
      className={cn(
        "flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm",
        "no-underline text-inherit transition-colors hover:bg-accent/50",
      )}
    >
      <div className={cn("flex items-center gap-2", COLUMN_WIDTHS.name)}>
        <Hexagon className="h-4 w-4 text-muted-foreground/70 shrink-0" />
        <span className="truncate font-medium">{project.name}</span>
      </div>
      <div className={cn("text-xs text-muted-foreground truncate", COLUMN_WIDTHS.lead)}>
        {leadAgent ? leadAgent.name : <span className="italic">unassigned</span>}
      </div>
      <div className={cn("text-xs text-muted-foreground truncate", COLUMN_WIDTHS.target)}>
        {targetLabel}
      </div>
      <div className={cn("text-xs text-muted-foreground", COLUMN_WIDTHS.goals)}>
        {goalCount === 0 ? "—" : `${goalCount} goal${goalCount === 1 ? "" : "s"}`}
      </div>
      <div className={COLUMN_WIDTHS.status}>
        <StatusBadge status={project.status} />
      </div>
      <div className={cn("text-xs text-muted-foreground truncate", COLUMN_WIDTHS.updated)}>
        {updatedLabel}
      </div>
    </Link>
  );
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sort, setSort] = useState<SortState>({ key: "updated", dir: "desc" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const projects = useMemo(() => {
    const visible = (allProjects ?? []).filter((p) => {
      if (statusFilter === "active" && p.archivedAt) return false;
      if (statusFilter === "archived" && !p.archivedAt) return false;
      // statusFilter === "all" → show everything
      if (search.trim().length > 0) {
        const q = search.trim().toLowerCase();
        if (!p.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    return [...visible].sort((a, b) => compareProjects(a, b, sort, agentsById));
  }, [allProjects, search, sort, statusFilter, agentsById]);

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Finite-duration containers for issues, agents, goals
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openNewProject()} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New project
        </Button>
      </header>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
            className="pl-8 h-8"
            aria-label="Search projects"
          />
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
          {(["active", "archived", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatusFilter(value)}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md border transition-colors capitalize",
                statusFilter === value
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40",
              )}
              aria-pressed={statusFilter === value}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {projects.length === 0 ? (
        <EmptyState
          icon={Hexagon}
          message="No projects."
          action="Create your first project"
          onAction={() => openNewProject()}
        />
      ) : (
        <div className="border border-border">
          <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2">
            <SortHeader label="Name" field="name" sort={sort} onSort={onSort} className={COLUMN_WIDTHS.name} />
            <SortHeader label="Lead" field="lead" sort={sort} onSort={onSort} className={COLUMN_WIDTHS.lead} />
            <SortHeader label="Target" field="target" sort={sort} onSort={onSort} className={COLUMN_WIDTHS.target} />
            <span
              className={cn(
                "text-xs font-medium text-muted-foreground uppercase tracking-wide",
                COLUMN_WIDTHS.goals,
              )}
            >
              Goals
            </span>
            <SortHeader label="Status" field="status" sort={sort} onSort={onSort} className={COLUMN_WIDTHS.status} />
            <SortHeader
              label="Last activity"
              field="updated"
              sort={sort}
              onSort={onSort}
              className={COLUMN_WIDTHS.updated}
            />
          </div>
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} agentsById={agentsById} />
          ))}
        </div>
      )}
    </div>
  );
}
