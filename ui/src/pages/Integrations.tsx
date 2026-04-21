import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Plug,
  FlaskConical,
} from "lucide-react";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_KINDS,
  type IntegrationKind,
  type Integration,
} from "@founderos/shared";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { integrationsApi } from "../api/integrations";
import { ConnectIntegrationDialog } from "../components/ConnectIntegrationDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusPill({
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

// ─── Connection state strip ───────────────────────────────────────────────────

function ConnectionStrip({
  integrations,
}: {
  integrations: Integration[];
}) {
  const kindMap = new Map(integrations.map((i) => [i.kind, i]));

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {INTEGRATION_KINDS.map((kind) => {
        const integration = kindMap.get(kind);
        const status = integration?.status ?? "disconnected";
        const catalog = INTEGRATION_CATALOG[kind];
        return (
          <a
            key={kind}
            href={`#${kind}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title={`${catalog.label} — ${status}`}
          >
            <StatusPill status={status} small />
            {catalog.label}
          </a>
        );
      })}
    </div>
  );
}

// ─── Integration card ─────────────────────────────────────────────────────────

function IntegrationCard({
  kind,
  integration,
  companyId,
  onConnect,
}: {
  kind: IntegrationKind;
  integration: Integration | undefined;
  companyId: string;
  onConnect: (kind: IntegrationKind) => void;
}) {
  const catalog = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const status: Integration["status"] | "disconnected" =
    integration?.status ?? "disconnected";

  const testMutation = useMutation({
    mutationFn: () => integrationsApi.test(companyId, integration!.id),
    onSuccess: () => {
      pushToast({ title: `${catalog.label} is reachable`, tone: "success" });
    },
    onError: () => {
      pushToast({ title: `${catalog.label} test failed`, tone: "error" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => integrationsApi.remove(companyId, integration!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations", companyId] });
      pushToast({ title: `Disconnected ${catalog.label}`, tone: "info" });
    },
    onError: () => {
      pushToast({ title: `Failed to disconnect ${catalog.label}`, tone: "error" });
    },
  });

  const deptLabel =
    catalog.department === "growth"
      ? "Growth · Read-only"
      : catalog.department === "crm"
        ? "CRM · Read + write"
        : "Chief of Staff · Read-only";

  return (
    <div
      id={kind}
      className={cn(
        "rounded-lg border bg-card p-5 flex flex-col gap-3",
        status === "error"
          ? "border-red-500/40"
          : "border-border",
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Brand avatar */}
          <div
            className="h-9 w-9 rounded-md border border-border flex items-center justify-center shrink-0 text-sm font-bold"
            style={{ background: "var(--muted)" }}
          >
            {catalog.label[0]}
          </div>
          <div>
            <div className="font-semibold text-sm text-foreground leading-tight">
              {catalog.label}
            </div>
            <span className="text-[11px] text-muted-foreground">{deptLabel}</span>
          </div>
        </div>
        <StatusPill status={status} />
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
        {catalog.description}
      </p>

      {/* Key hint */}
      {integration?.keyHint && (
        <div className="text-[11px] font-mono text-muted-foreground">
          API key: {integration.keyHint}
        </div>
      )}

      {/* Error state */}
      {status === "error" && integration?.lastError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {integration.lastError}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-auto pt-1">
        {status === "disconnected" || !integration ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => onConnect(kind)}
          >
            <Plug className="h-3.5 w-3.5 mr-1.5" />
            Connect
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5 mr-1.5" />
              )}
              Test
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="ml-auto">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={disconnectMutation.isPending}
                  onClick={() => disconnectMutation.mutate()}
                >
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Integrations() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const [connectKind, setConnectKind] = useState<IntegrationKind | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Integrations" }]);
  }, [setBreadcrumbs]);

  const { data: integrations = [], isLoading } = useQuery({
    queryKey: ["integrations", selectedCompanyId],
    queryFn: () => integrationsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  const totalCount = INTEGRATION_KINDS.length;

  const kindMap = new Map(integrations.map((i) => [i.kind, i]));

  const headlineText =
    connectedCount === 0
      ? "No integrations yet. Start with PostHog."
      : `${connectedCount} of ${totalCount} connected`;

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
        Select a company to manage integrations.
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-10 px-6 space-y-8">
      {/* Page header */}
      <div>
        <p className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground mb-2">
          Integrations
        </p>
        <h1 className="font-display text-3xl tracking-tight text-foreground">
          {headlineText}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-xl">
          Connect the stack you already use. Your AI team reads from these and
          acts through them.
        </p>
      </div>

      {/* Connection state strip */}
      {!isLoading && (
        <ConnectionStrip integrations={integrations} />
      )}

      {/* Integration grid */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading integrations…
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {INTEGRATION_KINDS.map((kind) => (
            <IntegrationCard
              key={kind}
              kind={kind}
              integration={kindMap.get(kind)}
              companyId={selectedCompanyId}
              onConnect={(k) => setConnectKind(k)}
            />
          ))}
        </div>
      )}

      {/* Connect dialog */}
      {connectKind && (
        <ConnectIntegrationDialog
          open={connectKind !== null}
          onOpenChange={(open) => {
            if (!open) setConnectKind(null);
          }}
          companyId={selectedCompanyId}
          kind={connectKind}
          onSuccess={() => setConnectKind(null)}
        />
      )}
    </div>
  );
}
