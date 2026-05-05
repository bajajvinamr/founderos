import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import type { Integration, IntegrationKind } from "@founderos/shared";
import { integrationsApi } from "../api/integrations";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface IntegrationCardProps {
  kind: IntegrationKind;
  integration: Integration | null;
  companyId: string;
  onConnect: () => void;
  lastSync?: string | null;
}

export function StatusPill({
  status,
  small,
}: {
  status: Integration["status"] | "disconnected";
  small?: boolean;
}) {
  const config = {
    connected: {
      label: "Connected",
      icon: CheckCircle2,
      class: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
    },
    error: {
      label: "Error",
      icon: AlertCircle,
      class: "text-red-600 dark:text-red-400 bg-red-500/10",
    },
    disconnected: {
      label: "Not connected",
      icon: Circle,
      class: "text-muted-foreground bg-muted",
    },
  }[status] ?? {
    label: "Unknown",
    icon: Circle,
    class: "text-muted-foreground bg-muted",
  };

  const Icon = config.icon;
  if (small) {
    return (
      <span
        title={`${config.label}`}
        className={cn(
          "inline-flex h-2.5 w-2.5 rounded-full shrink-0",
          status === "connected"
            ? "bg-emerald-500"
            : status === "error"
              ? "bg-red-500"
              : "bg-muted-foreground/30",
        )}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        config.class,
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

export function formatLastSync(lastSync?: string | null): string {
  if (!lastSync || lastSync === "never") return "Never synced";

  try {
    const syncDate = new Date(lastSync);
    const secondsAgo = (Date.now() - syncDate.getTime()) / 1000;

    if (isNaN(secondsAgo)) return "Never synced";
    if (secondsAgo < 60) return "Just now";
    if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
    if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;

    return `${Math.floor(secondsAgo / 86400)}d ago`;
  } catch {
    return "Never synced";
  }
}

export function IntegrationCard({
  kind,
  integration,
  companyId,
  onConnect,
  lastSync,
}: IntegrationCardProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const syncMutation = useMutation({
    mutationFn: () => integrationsApi.test(companyId, integration!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["integrations", companyId],
      });
      showToast({
        title: "Sync started",
        description: kind + " sync initiated",
      });
    },
    onError: () => {
      showToast({
        title: "Sync failed",
        description: "Unable to start sync",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => integrationsApi.remove(companyId, integration!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["integrations", companyId],
      });
      showToast({
        title: "Disconnected",
        description: kind + " integration removed",
      });
    },
    onError: () => {
      showToast({
        title: "Failed to disconnect",
        description: "Unable to remove integration",
        variant: "destructive",
      });
    },
  });

  const isConnected = integration?.status === "connected";
  const hasError = integration?.status === "error";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 bg-card transition-colors",
        hasError && "border-red-500/50 bg-red-500/5",
        !isConnected && !hasError && "border-muted-foreground/20"
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h3 className="font-semibold text-sm capitalize">{kind}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {formatLastSync(lastSync)}
          </p>
        </div>
        <StatusPill status={isConnected ? "connected" : hasError ? "error" : "disconnected"} />
      </div>

      {hasError && integration?.error && (
        <div className="mb-3 text-xs text-red-600 dark:text-red-400 bg-red-500/10 rounded px-2 py-1">
          {integration.error}
        </div>
      )}

      {isConnected ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="flex-1"
          >
            {syncMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : null}
            Sync now
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="px-2">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => disconnectMutation.mutate()}
                className="text-red-600 dark:text-red-400"
              >
                Disconnect
              </DropdownMenuItem>
              {hasError && <DropdownMenuItem>View errors</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <Button
          size="sm"
          className="w-full"
          onClick={onConnect}
        >
          Connect
        </Button>
      )}
    </div>
  );
}
