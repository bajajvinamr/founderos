/**
 * PostHogConnectCard — standalone card for connecting a PostHog project (S2.3)
 *
 * Standalone component: the orchestrator wires it into the integrations page
 * once S2.10 lands. Until then, it can be rendered anywhere that has
 * companyId + onSuccess available.
 *
 * PostHog uses API key auth (not OAuth). The card collects:
 *   - Personal API Key (required)
 *   - Project ID (required)
 *   - Host (optional — defaults to app.posthog.com, alt: eu.posthog.com)
 *
 * On submit, calls POST /api/integrations/posthog/connect and reflects
 * success/error back to the parent via onSuccess / toast.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "../context/ToastContext";
import { api } from "../api/client";
import type { Integration } from "@founderos/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PostHogConnectInput {
  companyId: string;
  projectId: string;
  apiKey: string;
  host: "https://app.posthog.com" | "https://eu.posthog.com";
}

interface Props {
  companyId: string;
  onSuccess: (integration: Integration) => void;
  existingIntegration?: Integration | null;
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function connectPostHog(input: PostHogConnectInput): Promise<Integration> {
  return api.post<Integration>("/integrations/posthog/connect", input);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PostHogConnectCard({
  companyId,
  onSuccess,
  existingIntegration,
}: Props) {
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [host, setHost] = useState<
    "https://app.posthog.com" | "https://eu.posthog.com"
  >("https://app.posthog.com");

  const { pushToast } = useToast();
  const isConnected = existingIntegration?.status === "connected";

  const connectMutation = useMutation({
    mutationFn: () =>
      connectPostHog({
        companyId,
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host,
      }),
    onSuccess: (integration) => {
      pushToast({ title: "PostHog connected", tone: "success" });
      setApiKey("");
      setProjectId("");
      onSuccess(integration);
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to connect PostHog";
      pushToast({ title: message, tone: "error" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || !projectId.trim()) return;
    connectMutation.mutate();
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">PostHog</h3>
          <p className="text-xs text-muted-foreground">
            Funnel analytics, activation events, and UTM attribution
          </p>
        </div>
        {isConnected && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected
          </span>
        )}
        {existingIntegration?.status === "error" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            Error
          </span>
        )}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="posthog-api-key" className="text-xs">
            Personal API Key
          </Label>
          <Input
            id="posthog-api-key"
            type="password"
            placeholder="phx_xxxxxxxxxxxxxxxxxxxx"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Find it in PostHog → Settings → Personal API Keys
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="posthog-project-id" className="text-xs">
            Project ID
          </Label>
          <Input
            id="posthog-project-id"
            type="text"
            placeholder="12345"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Find it in PostHog → Project Settings → Project ID
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="posthog-host" className="text-xs">
            Region
          </Label>
          <Select
            value={host}
            onValueChange={(v) =>
              setHost(
                v as "https://app.posthog.com" | "https://eu.posthog.com",
              )
            }
          >
            <SelectTrigger id="posthog-host" className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="https://app.posthog.com" className="text-xs">
                US — app.posthog.com
              </SelectItem>
              <SelectItem value="https://eu.posthog.com" className="text-xs">
                EU — eu.posthog.com
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between pt-1">
          <a
            href="https://posthog.com/docs/api/overview#authentication"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            How to find your API key
          </a>

          <Button
            type="submit"
            size="sm"
            disabled={
              !apiKey.trim() || !projectId.trim() || connectMutation.isPending
            }
          >
            {connectMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : null}
            {isConnected ? "Reconnect" : "Connect"}
          </Button>
        </div>
      </form>

      {existingIntegration?.lastError && (
        <p className="text-xs text-destructive bg-destructive/5 rounded px-2.5 py-1.5">
          Last error: {existingIntegration.lastError}
        </p>
      )}
    </div>
  );
}
