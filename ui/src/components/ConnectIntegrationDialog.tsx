import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import type { IntegrationKind } from "@founderos/shared";
import { INTEGRATION_CATALOG } from "@founderos/shared";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "../context/ToastContext";
import { integrationsApi } from "../api/integrations";
import { OAuthConnectButton } from "./OAuthConnectButton";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  kind: IntegrationKind;
  onSuccess: () => void;
};

export function ConnectIntegrationDialog({
  open,
  onOpenChange,
  companyId,
  kind,
  onSuccess,
}: Props) {
  const [apiKey, setApiKey] = useState("");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const catalog = INTEGRATION_CATALOG[kind];

  const connectMutation = useMutation({
    mutationFn: () => integrationsApi.create(companyId, { kind, apiKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations", companyId] });
      pushToast({ title: `Connected ${catalog.label}`, tone: "success" });
      setApiKey("");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to connect integration";
      pushToast({ title: message, tone: "error" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    connectMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            Connect {catalog.label}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
            {catalog.description}
          </p>
        </div>

        {catalog.authMethod === "oauth" ? (
          /* OAuth flow — single button, no form input */
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-muted-foreground">
              You'll be redirected to {catalog.label} to authorize access, then
              brought back here automatically.
            </p>
            <OAuthConnectButton kind={kind} companyId={companyId} />
          </div>
        ) : (
          /* API key paste flow */
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="api-key-input"
                className="text-sm font-medium text-foreground"
              >
                {catalog.keyLabel}
              </label>
              <Input
                id="api-key-input"
                type="password"
                placeholder="Paste your key here"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">{catalog.keyHint}</p>
            </div>

            <a
              href={catalog.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              Where to find this
            </a>
          </form>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setApiKey("");
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          {catalog.authMethod === "api_key" && (
            <Button
              size="sm"
              disabled={!apiKey.trim() || connectMutation.isPending}
              onClick={() => connectMutation.mutate()}
            >
              {connectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : null}
              Connect
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
