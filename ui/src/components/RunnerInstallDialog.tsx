/**
 * Modal for issuing, listing, and revoking BYO runner tokens.
 *
 * Token issuance is the security-critical surface: the plaintext
 * `fos_<32>` value is shown ONCE — after the user dismisses the freshly-
 * issued banner the server only retains the sha256 hash. The flow is:
 *
 *   1. Founder opens dialog from RunnerStatusPill (or Agents page)
 *   2. Picks a label (e.g. "macbook-air"), submits → POST /runner-tokens
 *   3. Plaintext token + install snippet rendered with Copy button
 *   4. Banner stays open until founder explicitly dismisses; closing the
 *      dialog re-prompts them to confirm they've copied it
 *   5. Below the banner: list of all tokens (active + revoked) with
 *      lastSeenAt + revoke button. Revoke is idempotent (DELETE returns 204).
 *
 * On 401 the api client throws — we surface it as an error toast.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/context/ToastContext";
import {
  runnerApi,
  type IssuedRunnerToken,
  type RunnerTokenWithRevoke,
} from "@/api/runner";
import { cn } from "@/lib/utils";

export interface RunnerInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  apiBaseUrl?: string;
}

export function RunnerInstallDialog({
  open,
  onOpenChange,
  companyId,
  apiBaseUrl,
}: RunnerInstallDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<IssuedRunnerToken | null>(null);

  const tokensQuery = useQuery({
    queryKey: ["runner-tokens", companyId],
    queryFn: () => runnerApi.list(companyId),
    enabled: open,
  });

  const issueMutation = useMutation({
    mutationFn: (newLabel: string) =>
      runnerApi.issue(companyId, newLabel.trim() || "default"),
    onSuccess: (token) => {
      setIssued(token);
      setLabel("");
      queryClient.invalidateQueries({ queryKey: ["runner-tokens", companyId] });
      queryClient.invalidateQueries({ queryKey: ["runner-status", companyId] });
    },
    onError: (err: Error) => {
      pushToast({
        title: "Couldn't issue token",
        body: err.message,
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => runnerApi.revoke(companyId, tokenId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runner-tokens", companyId] });
      queryClient.invalidateQueries({ queryKey: ["runner-status", companyId] });
      pushToast({ title: "Token revoked", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({
        title: "Couldn't revoke token",
        body: err.message,
        tone: "error",
      });
    },
  });

  function handleClose() {
    if (issued) {
      const ok = window.confirm(
        "The token won't be shown again. Have you copied it to a safe place?",
      );
      if (!ok) return;
    }
    setIssued(null);
    setLabel("");
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install runner</DialogTitle>
          <DialogDescription>
            The runner spawns your local <code>claude</code> CLI for FounderOS jobs.
            Issue a token, install the package, and keep the runner running on
            your machine.
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <IssuedTokenBanner
            token={issued}
            apiBaseUrl={apiBaseUrl}
            onAcknowledge={() => setIssued(null)}
            onCopy={() => pushToast({ title: "Token copied", tone: "success" })}
          />
        ) : (
          <form
            data-testid="runner-issue-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (issueMutation.isPending) return;
              issueMutation.mutate(label);
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="runner-token-label">Label</Label>
              <Input
                id="runner-token-label"
                placeholder="macbook-air"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
              />
              <p className="text-xs text-muted-foreground">
                Helps you identify which machine this token is for.
              </p>
            </div>
            <Button type="submit" disabled={issueMutation.isPending}>
              {issueMutation.isPending ? "Issuing…" : "Issue new token"}
            </Button>
          </form>
        )}

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Existing tokens
          </div>
          <TokenList
            tokens={tokensQuery.data?.tokens ?? []}
            isLoading={tokensQuery.isLoading}
            onRevoke={(tokenId) => revokeMutation.mutate(tokenId)}
            revokingTokenId={
              revokeMutation.isPending
                ? (revokeMutation.variables ?? null)
                : null
            }
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface IssuedTokenBannerProps {
  token: IssuedRunnerToken;
  apiBaseUrl?: string;
  onAcknowledge: () => void;
  onCopy: () => void;
}

function IssuedTokenBanner({
  token,
  apiBaseUrl,
  onAcknowledge,
  onCopy,
}: IssuedTokenBannerProps) {
  const [copied, setCopied] = useState(false);
  const apiOrigin = apiBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const installSnippet = [
    `npm install -g @founderos/runner`,
    `export FOUNDEROS_RUNNER_TOKEN="${token.token}"`,
    apiOrigin ? `export FOUNDEROS_API_URL="${apiOrigin}"` : `export FOUNDEROS_API_URL="https://founderos.fly.dev"`,
    `founderos-runner start`,
  ].join("\n");

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      onCopy();
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — fail soft. The token text is still selectable.
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(installSnippet);
      onCopy();
    } catch {
      // ignore
    }
  }

  return (
    <div
      data-testid="runner-issued-banner"
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide">
          Save this token now
        </div>
        <p className="text-xs">
          We only store its hash. You won't be able to see this value again.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <code
          data-testid="runner-issued-token"
          className="flex-1 truncate rounded bg-background/80 px-2 py-1 font-mono text-xs"
        >
          {token.token}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={copyToken}
          data-testid="runner-issued-copy"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Install snippet</span>
          <button
            type="button"
            className="text-xs underline"
            onClick={copySnippet}
            data-testid="runner-issued-snippet-copy"
          >
            Copy snippet
          </button>
        </div>
        <pre className="overflow-x-auto rounded bg-background/80 p-2 text-[11px] leading-relaxed">
          <code>{installSnippet}</code>
        </pre>
      </div>

      <Button type="button" variant="outline" size="sm" onClick={onAcknowledge}>
        I've saved it — issue another
      </Button>
    </div>
  );
}

interface TokenListProps {
  tokens: RunnerTokenWithRevoke[];
  isLoading: boolean;
  onRevoke: (tokenId: string) => void;
  revokingTokenId: string | null;
}

function TokenList({ tokens, isLoading, onRevoke, revokingTokenId }: TokenListProps) {
  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tokens…</p>;
  }
  if (tokens.length === 0) {
    return <p className="text-xs text-muted-foreground">No tokens yet.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="runner-token-list">
      {tokens.map((t) => {
        const revoked = t.revokedAt !== null;
        return (
          <li
            key={t.tokenId}
            className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
            data-testid={`runner-token-row-${t.tokenId}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{t.label || "(unlabeled)"}</span>
                <StatusBadge token={t} />
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t.lastSeenAt
                  ? `Last seen ${formatRelative(t.lastSeenAt)}`
                  : "Never seen"}
                {" · "}
                Created {formatRelative(t.createdAt)}
              </div>
            </div>
            {!revoked && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onRevoke(t.tokenId)}
                disabled={revokingTokenId === t.tokenId}
                aria-label={`Revoke ${t.label || "token"}`}
                data-testid={`runner-token-revoke-${t.tokenId}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadge({ token }: { token: RunnerTokenWithRevoke }) {
  if (token.revokedAt) {
    return (
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Revoked
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        token.online
          ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
          : "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          token.online ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      {token.online ? "Online" : "Offline"}
    </span>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
