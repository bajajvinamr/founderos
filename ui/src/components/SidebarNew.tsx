import {
  Home,
  CircleDot,
  Users,
  Boxes,
  Settings as SettingsIcon,
  BookOpen,
  Sun,
  Moon,
  LogOut,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { authApi } from "../api/auth";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { useTheme } from "../context/ThemeContext";
import { Button } from "@/components/ui/button";
import { branding } from "../branding";
import { cn } from "../lib/utils";

/**
 * Wave 1 — Ask-First shell sidebar.
 *
 * Five sections only — Today, Work, Team, Library, Settings. Per
 * 01-shell-revised.md §7 and the principle: "5 sections, ~16 destinations
 * one click in."
 *
 * Why this exists alongside the legacy `Sidebar.tsx`:
 *   - Wave 1 ships behind `FOUNDEROS_ASK_FIRST_SHELL` (default OFF).
 *   - When the flag is off, the legacy shell continues to render via the
 *     unchanged `Sidebar.tsx`. Rollback = flip the flag. No data migration.
 *   - This keeps the visual + structural surface of the new shell clean
 *     of vestigial legacy code paths.
 *
 * Critical contracts:
 *   - Today is the FIRST item — the founder lands here.
 *   - Today is the ONLY item that shows a count badge in chrome
 *     (Designer A §7.4 — "chrome counts compete with AskBar for attention").
 *   - Settings is LAST — it's a tool, not a destination.
 *   - "+ Add company" lives in the company switcher dropdown, not here.
 */

interface SidebarNavRowProps {
  to: string;
  label: string;
  icon: typeof Home;
  badge?: number;
}

function SidebarNavRow({ to, label, icon: Icon, badge }: SidebarNavRowProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </NavLink>
  );
}

export function SidebarNew() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

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

  // Today's badge — count of pending decisions (approvals awaiting
  // founder call). This is the ONLY chrome badge per §7.4. Inbox/
  // Approvals badges are gone from sidebar; their counts live inside Today.
  const { data: pendingApprovals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });
  const todayCount = pendingApprovals.filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;

  return (
    <aside className="flex h-full min-h-0 w-60 flex-col border-r border-border bg-background">
      {/* Top company-name strip; AskBar lives in the chrome header (Layout). */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        {selectedCompany?.brandColor && (
          <div
            className="h-4 w-4 shrink-0 rounded-sm"
            style={{ backgroundColor: selectedCompany.brandColor }}
            aria-hidden="true"
          />
        )}
        <span className="flex-1 truncate text-sm font-bold text-foreground">
          {selectedCompany?.name ?? "Select company"}
        </span>
      </div>

      <nav
        aria-label="Primary navigation"
        className="flex flex-1 min-h-0 flex-col gap-0.5 overflow-y-auto px-3 py-2"
      >
        <SidebarNavRow to="/today" label="Today" icon={Home} badge={todayCount} />
        <SidebarNavRow to="/work" label="Work" icon={CircleDot} />
        <SidebarNavRow to="/team" label="Team" icon={Users} />
        <SidebarNavRow to="/library" label="Library" icon={Boxes} />
        <SidebarNavRow to="/settings" label="Settings" icon={SettingsIcon} />
      </nav>

      {/* Footer — docs, settings, theme, account.
          The `+ Add company` action lives in the company-switcher dropdown
          per 01-shell-revised.md §4.1 (F-11), not here. */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border px-3 py-2.5">
        <div className="flex items-center gap-1">
          {branding.docsUrl && (
            <a
              href={branding.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">Docs</span>
            </a>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={toggleTheme}
            aria-label={`Switch to ${nextTheme} mode`}
            title={`Switch to ${nextTheme} mode`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
        {session?.user && (
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-foreground">
                {session.user.name ?? session.user.email ?? "Signed in"}
              </div>
              {session.user.email && session.user.name && (
                <div className="truncate text-[10px] text-muted-foreground">
                  {session.user.email}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
