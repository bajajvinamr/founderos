import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  CalendarClock,
  Brain,
  Settings,
  LogOut,
  ShieldCheck,
  Plug,
  Calendar,
  MessageSquare,
  Sun,
} from "lucide-react";
import { DEPARTMENTS } from "../lib/departments";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { authApi } from "../api/auth";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { useNavigate } from "@/lib/router";

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.clear();
      navigate("/auth");
    },
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  const { data: pendingApprovals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });
  const pendingApprovalCount = pendingApprovals.filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        {selectedCompany?.brandColor && (
          <div
            className="w-4 h-4 rounded-sm shrink-0 ml-1"
            style={{ backgroundColor: selectedCompany.brandColor }}
          />
        )}
        <span className="flex-1 text-sm font-bold text-foreground truncate pl-1">
          {selectedCompany?.name ?? "Select company"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          <SidebarNavItem to="/brief" label="Brief" icon={Sun} />
          <SidebarNavItem to="/weekly" label="Weekly" icon={Calendar} />
          <SidebarNavItem to="/conversations" label="Conversations" icon={MessageSquare} />
          <SidebarNavItem
            to="/decisions"
            label="Decisions"
            icon={ShieldCheck}
            badge={pendingApprovalCount > 0 ? pendingApprovalCount : undefined}
          />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label="Departments">
          {DEPARTMENTS.map((dept) => (
            <SidebarNavItem
              key={dept.id}
              to={`/departments/${dept.id}`}
              label={dept.label}
              icon={dept.icon}
            />
          ))}
        </SidebarSection>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/routines" label="Cadences" icon={CalendarClock} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Company">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/memory" label="Memory" icon={Brain} />
          <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
          <SidebarNavItem to="/integrations" label="Integrations" icon={Plug} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/audit" label="Audit" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>

      {/* Footer — current user + sign out. Always visible so founders don't
          have to dig into settings to end their session. */}
      {session?.user && (
        <div className="border-t border-border px-3 py-2.5 flex items-center gap-2 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium text-foreground truncate">
              {session.user.name ?? session.user.email ?? "Signed in"}
            </div>
            {session.user.email && session.user.name && (
              <div className="text-[10px] text-muted-foreground truncate">
                {session.user.email}
              </div>
            )}
          </div>
          <button
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            title="Sign out"
            aria-label="Sign out"
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </aside>
  );
}
