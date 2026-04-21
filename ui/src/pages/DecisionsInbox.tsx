import { useEffect, useState } from "react";
import { useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, CornerUpLeft } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { DEPARTMENTS, departmentForRole } from "../lib/departments";
import { PageTabBar } from "../components/PageTabBar";
import { ApprovalCard } from "../components/ApprovalCard";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import type { Approval, Agent } from "@founderos/shared";
import type { ApprovalType } from "@founderos/shared";

type FilterTab = "all" | "budget" | "publish" | "hire" | "other";

const BUDGET_TYPES: ApprovalType[] = ["budget_override_required"];
const HIRE_TYPES: ApprovalType[] = ["hire_agent"];
const PUBLISH_TYPES: ApprovalType[] = ["approve_ceo_strategy", "request_board_approval"];

function filterTypeTab(approval: Approval, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "budget") return BUDGET_TYPES.includes(approval.type);
  if (tab === "hire") return HIRE_TYPES.includes(approval.type);
  if (tab === "publish") return PUBLISH_TYPES.includes(approval.type);
  if (tab === "other") {
    return (
      !BUDGET_TYPES.includes(approval.type) &&
      !HIRE_TYPES.includes(approval.type) &&
      !PUBLISH_TYPES.includes(approval.type)
    );
  }
  return true;
}

interface DepartmentGroup {
  id: string;
  label: string;
  approvals: Approval[];
}

function groupByDepartment(approvals: Approval[], agents: Agent[]): DepartmentGroup[] {
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const groups: Map<string, DepartmentGroup> = new Map();

  // Pre-populate in desired order
  for (const dept of DEPARTMENTS) {
    groups.set(dept.id, { id: dept.id, label: dept.label, approvals: [] });
  }
  groups.set("unassigned", { id: "unassigned", label: "Unassigned", approvals: [] });

  for (const approval of approvals) {
    const agent = approval.requestedByAgentId ? agentById.get(approval.requestedByAgentId) : null;
    const dept = agent ? departmentForRole(agent.role) : undefined;
    const key = dept?.id ?? "unassigned";
    const group = groups.get(key);
    if (group) {
      group.approvals.push(approval);
    } else {
      groups.set(key, { id: key, label: dept?.label ?? "Unassigned", approvals: [approval] });
    }
  }

  return [...groups.values()].filter((g) => g.approvals.length > 0);
}

export function DecisionsInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [actionError, setActionError] = useState<string | null>(null);

  const activeFilter = (searchParams.get("filter") ?? "all") as FilterTab;

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions" }]);
  }, [setBreadcrumbs]);

  const { data: allApprovals = [], isLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidateApprovals = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending") });
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      setActionError(null);
      invalidateApprovals();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      invalidateApprovals();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const handleRedirect = (approvalId: string) => {
    pushToast({ title: "Redirect", body: `Redirect for approval ${approvalId} — coming soon.`, tone: "info" });
  };

  const pending = allApprovals.filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  );

  const filtered = pending.filter((a) => filterTypeTab(a, activeFilter));

  const groups = groupByDepartment(filtered, agents);

  const pendingCount = pending.length;

  const headlineText =
    pendingCount === 0
      ? "All clear. Team is unblocked."
      : pendingCount === 1
        ? "1 decision waiting"
        : `${pendingCount} decisions waiting`;

  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to view decisions." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <div className="space-y-1">
        <p className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          Decision Inbox
        </p>
        <h1 className="font-display text-3xl tracking-tight text-foreground">
          {headlineText}
        </h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {pendingCount} pending approval{pendingCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Filter tab bar */}
      <Tabs
        value={activeFilter}
        onValueChange={(v) => setSearchParams({ filter: v })}
      >
        <PageTabBar
          align="start"
          items={[
            { value: "all", label: "All" },
            { value: "budget", label: "Budget" },
            { value: "publish", label: "Publish" },
            { value: "hire", label: "Hire" },
            { value: "other", label: "Other" },
          ]}
        />
      </Tabs>

      {actionError && (
        <p className="text-sm text-destructive">{actionError}</p>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          message="All clear. The team is unblocked."
        />
      )}

      {/* Grouped sections */}
      {filtered.length > 0 && (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.id}>
              <div className="flex items-center gap-2.5 mb-3">
                <h2 className="font-display text-xl text-foreground">
                  {group.label}
                </h2>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {group.approvals.length}
                </span>
              </div>
              <div className="grid gap-3">
                {group.approvals.map((approval) => {
                  const requesterAgent = approval.requestedByAgentId
                    ? (agents.find((a) => a.id === approval.requestedByAgentId) ?? null)
                    : null;
                  return (
                    <div key={approval.id} className="relative">
                      <ApprovalCard
                        approval={approval}
                        requesterAgent={requesterAgent}
                        onApprove={() => approveMutation.mutate(approval.id)}
                        onReject={() => rejectMutation.mutate(approval.id)}
                        detailLink={`/approvals/${approval.id}`}
                        isPending={isMutating}
                        pendingAction={
                          approveMutation.isPending
                            ? "approve"
                            : rejectMutation.isPending
                              ? "reject"
                              : null
                        }
                      />
                      {/* Redirect action — sits outside ApprovalCard to avoid layout conflict */}
                      <div className="hidden md:block absolute bottom-4 right-[7.5rem]">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto px-2 text-xs text-muted-foreground gap-1.5"
                          onClick={() => handleRedirect(approval.id)}
                          disabled={isMutating}
                        >
                          <CornerUpLeft className="h-3.5 w-3.5" />
                          Redirect
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
