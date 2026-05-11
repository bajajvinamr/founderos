/**
 * Audit P0.2 — Notification Bell.
 *
 * Top-bar bell icon with unread badge + popover dropdown. Polls
 * `/api/companies/:companyId/notifications/unread-count` every 30s; opens
 * a popover that fetches the list lazily on first open.
 *
 * No WebSocket: the audit explicitly accepted polling for V1. WS push is
 * deferred to a follow-up.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCircle2, Lightbulb, PlugZap } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "../context/CompanyContext";
import {
  notificationsApi,
  type NotificationKind,
  type NotificationRow,
} from "../api/notifications";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const POLL_MS = 30_000;

/** Per-kind icon — kept tiny; falls back to bell. */
function KindIcon({ kind }: { kind: NotificationKind }) {
  const className = "h-4 w-4 shrink-0";
  switch (kind) {
    case "approval_needed":
      return <AlertTriangle className={cn(className, "text-amber-600 dark:text-amber-400")} />;
    case "insight_critical":
      return <Lightbulb className={cn(className, "text-blue-600 dark:text-blue-400")} />;
    case "workflow_completed":
      return <CheckCircle2 className={cn(className, "text-emerald-600 dark:text-emerald-400")} />;
    case "integration_failed":
      return <PlugZap className={cn(className, "text-red-600 dark:text-red-400")} />;
    default:
      return <Bell className={className} />;
  }
}

/** Best-effort link target for a notification. Other ref kinds: no link. */
function notificationHref(
  row: NotificationRow,
  companyPrefix: string | null,
): string | null {
  if (row.refKind === "approval" && row.refId) {
    // Approvals live at /:companyPrefix/approvals/:id when the prefix is
    // known; fall back to the unprefixed approval detail otherwise.
    if (companyPrefix) return `/${companyPrefix}/approvals/${row.refId}`;
    return `/approvals/${row.refId}`;
  }
  return null;
}

export function NotificationBell() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? null;
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  // Unread count query — polls every 30s while mounted. Disabled when no
  // company is selected (e.g. instance settings, onboarding) to avoid
  // 403s on the count endpoint.
  const countQuery = useQuery({
    queryKey: ["notifications", "unread-count", selectedCompanyId],
    queryFn: () => notificationsApi.unreadCount(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

  // List query — only fires while the popover is open. Limit 20 per spec.
  const listQuery = useQuery({
    queryKey: ["notifications", "list", selectedCompanyId],
    queryFn: () =>
      notificationsApi.list(selectedCompanyId as string, { limit: 20 }),
    enabled: Boolean(selectedCompanyId) && open,
    retry: false,
  });

  const markReadMutation = useMutation({
    mutationFn: (notificationId: string) =>
      notificationsApi.markRead(selectedCompanyId as string, notificationId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["notifications", "unread-count", selectedCompanyId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications", "list", selectedCompanyId],
      });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => notificationsApi.markAllRead(selectedCompanyId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["notifications", "unread-count", selectedCompanyId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications", "list", selectedCompanyId],
      });
    },
  });

  const unreadCount = countQuery.data?.unreadCount ?? 0;
  const rows = listQuery.data?.notifications ?? [];

  // Hide entirely when no company is selected — count endpoint is
  // tenant-scoped, so the bell would be inert anyway.
  if (!selectedCompanyId) return null;

  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 text-muted-foreground"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
          data-testid="notification-bell"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 inline-flex min-w-[1.125rem] h-[1.125rem] items-center justify-center rounded-full bg-red-600 dark:bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
              data-testid="notification-bell-badge"
            >
              {badgeLabel}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-96 p-0"
        data-testid="notification-bell-popover"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-[13px] font-medium">Notifications</h2>
          {unreadCount > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => markAllReadMutation.mutate()}
              disabled={markAllReadMutation.isPending}
              data-testid="notification-bell-mark-all-read"
            >
              Mark all as read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-auto">
          {listQuery.isLoading ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => {
                const href = notificationHref(row, companyPrefix);
                const isUnread = row.readAt === null;
                const onClick = () => {
                  if (isUnread) markReadMutation.mutate(row.id);
                  setOpen(false);
                };
                const content = (
                  <div className="flex items-start gap-2 px-3 py-2">
                    <div className="pt-0.5">
                      <KindIcon kind={row.kind} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p
                          className={cn(
                            "text-[13px] truncate",
                            isUnread ? "font-medium text-foreground" : "text-foreground/80",
                          )}
                        >
                          {row.title}
                        </p>
                        <span className="text-[11px] text-muted-foreground shrink-0">
                          {timeAgo(row.createdAt)}
                        </span>
                      </div>
                      {row.body && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {row.body}
                        </p>
                      )}
                    </div>
                    {isUnread && (
                      <span
                        className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--brand)] shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                );
                return (
                  <li key={row.id}>
                    {href ? (
                      <Link
                        to={href}
                        onClick={onClick}
                        className="block hover:bg-accent/50 transition-colors"
                        data-testid={`notification-row-${row.id}`}
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={onClick}
                        className="w-full text-left hover:bg-accent/50 transition-colors"
                        data-testid={`notification-row-${row.id}`}
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
