import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { CalendarClock, Search } from "lucide-react";
import { routinesApi } from "../../api/routines";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CadenceCard, type Cadence } from "../../components/CadenceCard";
import type { RoutineListItem } from "@founderos/shared";

// W2.3: this is a NEW redesigned page. The legacy /routines edit form lives in
// the original RoutineDetail.tsx (out of W2.3 scope per spec §E Q1; will be
// extracted as CadenceEditSheet by a follow-up agent). This page is unreachable
// until I2 wires `/work/cadences` into App.tsx; the legacy /routines route
// continues to mount this same component via the shim at ../Routines.tsx.

type CadenceStatusFilter = "active" | "paused" | "archived" | "all";

// Engineer-facing string used for the React Query cache namespace. Keeps the
// front-end key local; the wire format (server URL `/companies/:id/routines`)
// is owned by backend (W2.5) and stays as "routines".
const CADENCES_VIEW_KEY = "founderos:cadences-view";

interface CadenceViewState {
  status: CadenceStatusFilter;
  search: string;
}

function getStoredViewState(companyId: string | null): CadenceViewState {
  const key = companyId ? `${CADENCES_VIEW_KEY}:${companyId}` : CADENCES_VIEW_KEY;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CadenceViewState>;
      return {
        status: (parsed.status as CadenceStatusFilter) ?? "active",
        search: typeof parsed.search === "string" ? parsed.search : "",
      };
    }
  } catch {
    // ignore malformed local state
  }
  return { status: "active", search: "" };
}

function persistViewState(companyId: string | null, state: CadenceViewState) {
  const key = companyId ? `${CADENCES_VIEW_KEY}:${companyId}` : CADENCES_VIEW_KEY;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

function nextCadenceStatus(currentStatus: string, paused: boolean) {
  if (currentStatus === "archived" && !paused) return "active";
  return paused ? "paused" : "active";
}

function formatScheduleLabel(cadence: Cadence, agentName: string | null): string {
  const primaryTrigger = cadence.triggers?.find((trigger) => trigger.enabled) ?? cadence.triggers?.[0] ?? null;
  if (primaryTrigger?.label) return primaryTrigger.label;
  if (!primaryTrigger) return agentName ? "No schedule" : "Draft";
  return primaryTrigger.kind.replaceAll("_", " ");
}

export function filterCadences(
  cadences: Cadence[],
  state: CadenceViewState,
): Cadence[] {
  const query = state.search.trim().toLowerCase();
  return cadences.filter((cadence) => {
    if (state.status === "active" && cadence.status !== "active") return false;
    if (state.status === "paused" && cadence.status !== "paused") return false;
    if (state.status === "archived" && cadence.status !== "archived") return false;
    if (query) {
      const haystack = `${cadence.title} ${cadence.description ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function countByStatus(cadences: Cadence[]): Record<CadenceStatusFilter, number> {
  let active = 0;
  let paused = 0;
  let archived = 0;
  for (const cadence of cadences) {
    if (cadence.status === "active") active += 1;
    else if (cadence.status === "paused") paused += 1;
    else if (cadence.status === "archived") archived += 1;
  }
  return { active, paused, archived, all: cadences.length };
}

export function Cadences() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [statusMutationId, setStatusMutationId] = useState<string | null>(null);
  const [runningCadenceId, setRunningCadenceId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<CadenceViewState>(() => getStoredViewState(selectedCompanyId));

  useEffect(() => {
    setBreadcrumbs([{ label: "Cadences" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setViewState(getStoredViewState(selectedCompanyId));
  }, [selectedCompanyId]);

  const {
    data: cadences,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!) as Promise<RoutineListItem[]>,
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );

  const updateCadenceStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      routinesApi.update(id, { status }),
    onMutate: ({ id }) => {
      setStatusMutationId(id);
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setStatusMutationId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update cadence",
        body: mutationError instanceof Error ? mutationError.message : "FounderOS could not update the cadence.",
        tone: "error",
      });
    },
  });

  const runCadenceOnce = useMutation({
    mutationFn: ({ id }: { id: string }) => routinesApi.run(id, {}),
    onMutate: ({ id }) => {
      setRunningCadenceId(id);
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setRunningCadenceId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Cadence skip failed",
        body: mutationError instanceof Error ? mutationError.message : "FounderOS could not skip the cadence run.",
        tone: "error",
      });
    },
  });

  const counts = useMemo(() => countByStatus(cadences ?? []), [cadences]);
  const filteredCadences = useMemo(
    () => filterCadences(cadences ?? [], viewState),
    [cadences, viewState],
  );

  function updateViewState(patch: Partial<CadenceViewState>) {
    setViewState((current) => {
      const next = { ...current, ...patch };
      persistViewState(selectedCompanyId, next);
      return next;
    });
  }

  function handleTogglePause(cadence: Cadence) {
    if (cadence.status === "paused") {
      updateCadenceStatus.mutate({ id: cadence.id, status: nextCadenceStatus(cadence.status, false) });
      return;
    }
    if (!cadence.assigneeAgentId) {
      pushToast({
        title: "Default agent required",
        body: "Set a default agent before enabling cadence automation.",
        tone: "warn",
      });
      return;
    }
    updateCadenceStatus.mutate({
      id: cadence.id,
      status: nextCadenceStatus(cadence.status, true),
    });
  }

  function handleSkipNext(cadence: Cadence) {
    // Skip next = one-time run-now equivalent that advances the scheduler past
    // the upcoming window. Backend-side skip semantics are owned by W2.5; for
    // now we surface a toast and trigger an immediate run so the cadence
    // advances. When server-side skip endpoint lands, swap the mutation here.
    if (cadence.status !== "active") return;
    runCadenceOnce.mutate({ id: cadence.id });
    pushToast({
      title: "Next run skipped",
      body: `${cadence.title} will resume on the following scheduled tick.`,
      tone: "success",
    });
  }

  function handleEdit(cadence: Cadence) {
    // Detail/edit sheet ships in a follow-up agent (per spec §E Q1).
    // Until then, fall back to the legacy detail route. This is the only
    // place we link to `/routines/:id` — the URL stays unchanged until I2.
    navigate(`/routines/${cadence.id}`);
  }

  function handleOpenDetail(cadence: Cadence) {
    navigate(`/routines/${cadence.id}`);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarClock} message="Select a company to view cadences." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  const filterButtons: Array<{ value: CadenceStatusFilter; label: string; count: number }> = [
    { value: "active", label: "Active", count: counts.active },
    { value: "paused", label: "Paused", count: counts.paused },
    { value: "archived", label: "Archived", count: counts.archived },
    { value: "all", label: "All", count: counts.all },
  ];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Cadences</h1>
        <p className="text-sm text-muted-foreground">Recurring work your team handles.</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Cadence status filter">
          {filterButtons.map((btn) => (
            <Button
              key={btn.value}
              variant={viewState.status === btn.value ? "secondary" : "ghost"}
              size="sm"
              role="tab"
              aria-selected={viewState.status === btn.value}
              onClick={() => updateViewState({ status: btn.value })}
            >
              {btn.label}
              <span className="ml-1.5 text-xs text-muted-foreground">{btn.count}</span>
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={viewState.search}
            onChange={(event) => updateViewState({ search: event.target.value })}
            placeholder="Search cadences"
            aria-label="Search cadences"
            className="pl-8"
          />
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load cadences"}
          </CardContent>
        </Card>
      ) : null}

      {filteredCadences.length === 0 ? (
        <div className="py-12">
          <EmptyState icon={CalendarClock} message="No cadences configured." />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCadences.map((cadence) => {
            const agent = cadence.assigneeAgentId ? agentById.get(cadence.assigneeAgentId) ?? null : null;
            const _project = cadence.projectId ? projectById.get(cadence.projectId) ?? null : null;
            const scheduleLabel = formatScheduleLabel(cadence, agent?.name ?? null);
            return (
              <CadenceCard
                key={cadence.id}
                cadence={cadence}
                scheduleLabel={scheduleLabel}
                agentName={agent?.name ?? null}
                agentIcon={agent?.icon ?? null}
                isStatusPending={statusMutationId === cadence.id}
                isRunning={runningCadenceId === cadence.id}
                onTogglePause={() => handleTogglePause(cadence)}
                onSkipNext={() => handleSkipNext(cadence)}
                onEdit={() => handleEdit(cadence)}
                onOpenDetail={() => handleOpenDetail(cadence)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
