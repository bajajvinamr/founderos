import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Key,
  Loader2,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  templatesApi,
  type ProviderCredentialReport,
  type ProvidersResponse,
  type StoredApiKeyRecord,
} from "@/api/templates";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Instance-level AI Providers settings.
 *
 * Shows which providers this instance has credentials for (detected via
 * env vars + local CLI presence) and explains how to add more. Keys are
 * currently set via env at server boot; inline-edit UI is a future step.
 */
export function InstanceProvidersSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "AI Providers" }]);
  }, [setBreadcrumbs]);

  const providersQuery = useQuery({
    queryKey: ["providers", "status"],
    queryFn: () => templatesApi.providers(),
    refetchInterval: 30_000,
  });

  if (providersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading provider status…</div>;
  }
  if (!providersQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {providersQuery.error instanceof Error ? providersQuery.error.message : "Failed to load providers"}
      </div>
    );
  }

  const { availability, providers } = providersQuery.data;

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Providers</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          FounderOS agents can run on Claude, OpenAI / Codex, or Gemini. Each provider can be
          used via its local CLI (via your paid subscription) or a direct API key (billed
          per-token). Set up at least one before spawning a company.
        </p>
      </div>

      {!availability.anyConfigured && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-semibold text-foreground">No providers configured</div>
            <div className="mt-1 text-muted-foreground">
              Your agents won't be able to run until you set up at least one provider below.
              The fastest path is the Claude Code CLI (free with a Claude subscription) — it
              auto-detects once installed.
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.family}
            report={p}
            storedKey={providersQuery.data?.storedKeys.find(
              (sk) => sk.family === p.family && sk.executionMode === "api",
            )}
          />
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 text-sm">
        <div className="font-semibold text-foreground mb-2">Why two options per provider?</div>
        <ul className="space-y-1.5 text-muted-foreground leading-relaxed list-disc ml-5">
          <li>
            <span className="font-medium text-foreground">CLI (subscription):</span> uses your
            paid Claude / Codex / Gemini subscription. No per-token billing. Best if you already
            pay monthly.
          </li>
          <li>
            <span className="font-medium text-foreground">API key:</span> direct to
            Anthropic / OpenAI / Google. Billed per-token. Best for scaled usage or headless
            deployments.
          </li>
          <li>
            <span className="font-medium text-foreground">Both configured:</span> FounderOS
            defaults to CLI but automatically falls back to the API if the CLI fails.
          </li>
        </ul>
      </div>
    </div>
  );
}

function ProviderCard({
  report,
  storedKey,
}: {
  report: ProviderCredentialReport;
  storedKey: StoredApiKeyRecord | undefined;
}) {
  const meta = PROVIDER_META[report.family];
  const anyAvail = report.api.configured || report.cli.installed;

  return (
    <div
      className={cn(
        "rounded-xl border p-5 transition-colors",
        anyAvail ? "border-[color:color-mix(in_oklch,var(--brand)_25%,var(--border))] bg-card" : "border-border bg-card/60",
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg text-lg shrink-0"
          style={{
            background: anyAvail
              ? "color-mix(in oklch, var(--brand) 14%, transparent)"
              : "color-mix(in oklch, var(--muted) 50%, transparent)",
          }}
        >
          {meta.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
            {anyAvail ? (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] font-semibold text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Available
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] font-semibold text-muted-foreground">
                <Circle className="h-3 w-3" />
                Not configured
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{meta.description}</p>
        </div>
      </div>

      <div className="mt-4 grid md:grid-cols-2 gap-3">
        <MethodRow
          icon={Terminal}
          label="Local CLI"
          status={
            report.cli.installed && report.cli.authed
              ? "green"
              : report.cli.installed
                ? "yellow"
                : "grey"
          }
          title={
            report.cli.installed && report.cli.authed ? "Detected & authed"
            : report.cli.installed ? "Installed, run `" + meta.cliLoginCmd + "` to auth"
            : "Not installed"
          }
          hint={report.cli.path ?? meta.installCmd}
          docsHref={meta.cliDocs}
        />
        <MethodRow
          icon={Key}
          label="API key"
          status={report.api.configured ? "green" : "grey"}
          title={
            report.api.configured
              ? `Configured via ${
                  report.api.source === "env" ? "env var"
                  : report.api.source === "instance_secret" ? "stored in instance"
                  : "unknown"
                }`
              : "Not configured"
          }
          hint={
            report.api.configured
              ? storedKey?.keyHint ?? `Set ${meta.envVarName}=<your key>`
              : `Or paste it below`
          }
          docsHref={meta.apiDocs}
        />
      </div>

      <InlineKeyEditor
        family={report.family}
        envVarName={meta.envVarName}
        existingStoredKey={storedKey}
        envConfigured={report.api.source === "env"}
      />
    </div>
  );
}

function InlineKeyEditor({
  family,
  envVarName,
  existingStoredKey,
  envConfigured,
}: {
  family: "anthropic" | "openai" | "google";
  envVarName: string;
  existingStoredKey: StoredApiKeyRecord | undefined;
  envConfigured: boolean;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const setMutation = useMutation({
    mutationFn: () =>
      templatesApi.setProviderKey({ family, executionMode: "api", value }),
    onSuccess: () => {
      setValue("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["providers", "status"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.deleteProviderKey(family, "api"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers", "status"] });
    },
  });

  return (
    <div className="mt-4 border-t border-border pt-4">
      {existingStoredKey ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Instance-stored key: <code className="font-mono">{existingStoredKey.keyHint ?? "****"}</code>
            <span className="ml-2">· updated {new Date(existingStoredKey.updatedAt).toLocaleString()}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="text-destructive hover:text-destructive gap-1"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Remove
          </Button>
        </div>
      ) : !open ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={envConfigured}
          className="gap-1.5 w-full"
        >
          <Key className="h-3 w-3" />
          {envConfigured ? `${envVarName} is set via env` : "Paste API key"}
        </Button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim().length > 0) setMutation.mutate();
          }}
          className="space-y-2"
        >
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            placeholder={`Paste your ${envVarName}…`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={setMutation.isPending}
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={setMutation.isPending || value.trim().length < 4}>
              {setMutation.isPending ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> Saving…
                </>
              ) : (
                "Save key"
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
              disabled={setMutation.isPending}
            >
              Cancel
            </Button>
            <span className="text-[10px] text-muted-foreground ml-auto">
              Encrypted with your instance master key. Never shown again after save.
            </span>
          </div>
          {setMutation.error instanceof Error && (
            <div className="text-xs text-destructive">{setMutation.error.message}</div>
          )}
        </form>
      )}
    </div>
  );
}

/** Drop reference to keep setMutation lint-clean when ProvidersResponse changes */
void ({} as ProvidersResponse);

function MethodRow({
  icon: Icon,
  label,
  status,
  title,
  hint,
  docsHref,
}: {
  icon: typeof Terminal;
  label: string;
  status: "green" | "yellow" | "grey";
  title: string;
  hint: string;
  docsHref: string;
}) {
  const color =
    status === "green" ? "text-emerald-600 dark:text-emerald-400"
    : status === "yellow" ? "text-amber-600 dark:text-amber-400"
    : "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5", color)} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div className={cn("mt-1 text-sm font-medium", color)}>{title}</div>
      <code className="mt-1 block text-[11px] font-mono text-muted-foreground break-all">
        {hint}
      </code>
      <a
        href={docsHref}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--brand)] hover:underline"
      >
        Docs
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

// Hardcoded provider meta — descriptions + docs links + install commands.
const PROVIDER_META: Record<
  "anthropic" | "openai" | "google",
  {
    label: string;
    description: string;
    icon: string;
    envVarName: string;
    installCmd: string;
    cliLoginCmd: string;
    cliDocs: string;
    apiDocs: string;
  }
> = {
  anthropic: {
    label: "Anthropic — Claude",
    description:
      "Runs agents via the `claude` CLI (Claude Code subscription auth) or direct API. Best for reasoning-heavy roles like CEO, CTO, Evals.",
    icon: "🟠",
    envVarName: "ANTHROPIC_API_KEY",
    installCmd: "npm i -g @anthropic-ai/claude-code",
    cliLoginCmd: "claude /login",
    cliDocs: "https://docs.claude.com/en/docs/claude-code",
    apiDocs: "https://docs.anthropic.com/en/api/getting-started",
  },
  openai: {
    label: "OpenAI — Codex / GPT-5",
    description:
      "Runs agents via the `codex` CLI (OpenAI subscription) or direct API. Great for sales, content, and high-volume workloads.",
    icon: "🔵",
    envVarName: "OPENAI_API_KEY",
    installCmd: "npm i -g @openai/codex",
    cliLoginCmd: "codex login",
    cliDocs: "https://platform.openai.com/docs/codex",
    apiDocs: "https://platform.openai.com/docs/api-reference",
  },
  google: {
    label: "Google — Gemini",
    description:
      "Runs agents via the `gemini` CLI (Google AI subscription) or Google AI Studio API key. Strong mix of quality + value for ops work.",
    icon: "🟢",
    envVarName: "GEMINI_API_KEY",
    installCmd: "npm i -g @google/gemini-cli",
    cliLoginCmd: "gemini login",
    cliDocs: "https://github.com/google-gemini/gemini-cli",
    apiDocs: "https://ai.google.dev/api",
  },
};
