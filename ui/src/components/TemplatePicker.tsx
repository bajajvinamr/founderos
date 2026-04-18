import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import type { TemplateSummary } from "@founderos/shared";
import {
  ArrowRight,
  Loader2,
  Sparkles,
  Users,
  Target,
  Flag,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { templatesApi, type ProviderStrategy, type ProvidersResponse } from "@/api/templates";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";

interface TemplatePickerProps {
  /** Called after successful spawn. Defaults to navigating to the dashboard. */
  onSpawned?: (companyId: string) => void;
}

/**
 * Template picker UI — the 10-minute onboarding flow.
 *
 * Step 1: Grid of template cards with agent/goal/project counts.
 * Step 2: Inline confirmation (name override + spawn button).
 */
export function TemplatePicker({ onSpawned }: TemplatePickerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [strategy, setStrategy] = useState<ProviderStrategy>("mixed");

  const templatesQuery = useQuery({
    queryKey: ["templates", "list"],
    queryFn: () => templatesApi.list(),
  });

  const providersQuery = useQuery({
    queryKey: ["providers", "status"],
    queryFn: () => templatesApi.providers(),
  });

  const spawnMutation = useMutation({
    mutationFn: (input: {
      templateId: string;
      companyName?: string;
      providerStrategy?: ProviderStrategy;
    }) => templatesApi.spawn(input),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(data.companyId);
      if (onSpawned) {
        onSpawned(data.companyId);
      } else {
        navigate("/dashboard");
      }
    },
  });

  const selected = selectedId
    ? templatesQuery.data?.find((t) => t.id === selectedId) ?? null
    : null;

  if (templatesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (selected) {
    return (
      <TemplateConfirm
        template={selected}
        companyName={companyName}
        onCompanyNameChange={setCompanyName}
        strategy={strategy}
        onStrategyChange={setStrategy}
        providers={providersQuery.data}
        onBack={() => {
          setSelectedId(null);
          setCompanyName("");
          setStrategy("mixed");
          spawnMutation.reset();
        }}
        onSpawn={() => {
          spawnMutation.mutate({
            templateId: selected.id,
            companyName: companyName.trim() || undefined,
            providerStrategy: strategy,
          });
        }}
        isPending={spawnMutation.isPending}
        error={
          spawnMutation.error instanceof Error
            ? spawnMutation.error.message
            : null
        }
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 md:py-20">
      <div className="mb-10">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand)] mb-3">
          <Sparkles className="h-3.5 w-3.5" />
          Pick a template
        </div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-[1.1] text-foreground">
          Your company,{" "}
          <span className="text-[var(--brand)]">alive in ten minutes.</span>
        </h1>
        <p className="mt-4 max-w-xl text-base text-muted-foreground leading-relaxed">
          Each template spins up a fully-wired company: agents with task-oriented
          prompts, goals, first projects, and a starter inbox. Pick one, tweak later.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {templatesQuery.data?.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            onSelect={() => {
              setSelectedId(t.id);
              setCompanyName(t.name);
            }}
          />
        ))}
      </div>

      {templatesQuery.error && (
        <p className="mt-6 text-sm text-destructive">
          {templatesQuery.error instanceof Error
            ? templatesQuery.error.message
            : "Failed to load templates"}
        </p>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onSelect,
}: {
  template: TemplateSummary;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex flex-col items-start text-left rounded-xl border border-border bg-card p-5 transition-all",
        "hover:border-[color:color-mix(in_oklch,var(--brand)_45%,var(--border))]",
        "hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--brand)_35%,transparent)]",
      )}
    >
      <div
        className="flex h-10 w-10 items-center justify-center rounded-lg mb-4 text-xl"
        style={{
          background: "color-mix(in oklch, var(--brand) 14%, transparent)",
        }}
      >
        {template.icon}
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1">
        {template.name}
      </h3>
      <p className="text-sm text-muted-foreground leading-snug mb-4">
        {template.tagline}
      </p>
      <p className="text-[13px] text-muted-foreground/90 leading-relaxed mb-5 line-clamp-3">
        {template.summary}
      </p>
      <div className="mt-auto flex items-center gap-3 text-[11px] text-muted-foreground">
        <StatBadge icon={Users} label={`${template.agentCount} agents`} />
        <StatBadge icon={Flag} label={`${template.goalCount} goals`} />
        <StatBadge icon={Target} label={`${template.projectCount} projects`} />
      </div>
      <div className="mt-5 flex items-center gap-1.5 text-xs font-medium text-[var(--brand)] opacity-70 group-hover:opacity-100 transition-opacity">
        Use this template
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

function StatBadge({
  icon: Icon,
  label,
}: {
  icon: typeof Users;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Icon className="h-3 w-3" />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

function TemplateConfirm({
  template,
  companyName,
  onCompanyNameChange,
  strategy,
  onStrategyChange,
  providers,
  onBack,
  onSpawn,
  isPending,
  error,
}: {
  template: TemplateSummary;
  companyName: string;
  onCompanyNameChange: (v: string) => void;
  strategy: ProviderStrategy;
  onStrategyChange: (s: ProviderStrategy) => void;
  providers: ProvidersResponse | undefined;
  onBack: () => void;
  onSpawn: () => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-14 md:py-20">
      <button
        type="button"
        onClick={onBack}
        disabled={isPending}
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 mb-8"
      >
        ← Back to templates
      </button>
      <div
        className="flex h-14 w-14 items-center justify-center rounded-xl mb-6 text-2xl"
        style={{
          background: "color-mix(in oklch, var(--brand) 14%, transparent)",
        }}
      >
        {template.icon}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {template.name}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
        {template.summary}
      </p>

      <div className="mt-8 space-y-5">
        <div className="space-y-2">
          <label
            htmlFor="company-name"
            className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            Company name
          </label>
          <Input
            id="company-name"
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            placeholder={template.name}
            disabled={isPending}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            You can rename this later in company settings.
          </p>
        </div>

        <ProviderStrategyPicker
          strategy={strategy}
          onStrategyChange={onStrategyChange}
          providers={providers}
          disabled={isPending}
        />

        <div className="rounded-lg bg-secondary/30 border border-border p-4 text-xs text-muted-foreground leading-relaxed space-y-2">
          <div className="font-semibold text-foreground">What gets created:</div>
          <ul className="space-y-1">
            <li>
              • <span className="text-foreground font-medium">{template.agentCount}</span>{" "}
              agents with task-oriented heartbeat prompts
            </li>
            <li>
              • <span className="text-foreground font-medium">{template.goalCount}</span>{" "}
              company-level goals
            </li>
            <li>
              • <span className="text-foreground font-medium">{template.projectCount}</span>{" "}
              projects with owners + starter issues
            </li>
            <li>• The company budget + metrics pre-seeded for your stage</li>
          </ul>
        </div>

        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}

        <Button
          type="button"
          size="lg"
          onClick={onSpawn}
          disabled={isPending || companyName.trim().length === 0}
          className="w-full gap-2"
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Spawning your company…
            </>
          ) : (
            <>
              Spin up {companyName.trim() || template.name}
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Provider strategy picker
// ────────────────────────────────────────────────────────────────────────

type StrategyOption = {
  id: "mixed" | "anthropic_first" | "openai_first" | "google_first";
  label: string;
  sub: string;
  /** Which family needs to be available for this option to be enabled. */
  requires: "any" | "anthropic" | "openai" | "google";
};

const STRATEGY_OPTIONS: StrategyOption[] = [
  {
    id: "mixed",
    label: "Mixed (recommended)",
    sub: "Respect per-agent template preference. Falls back across providers if one is missing.",
    requires: "any",
  },
  {
    id: "anthropic_first",
    label: "Anthropic first",
    sub: "Every agent uses Claude (via your subscription CLI or API key).",
    requires: "anthropic",
  },
  {
    id: "openai_first",
    label: "OpenAI first",
    sub: "Every agent uses Codex / GPT-5 (via subscription CLI or API key).",
    requires: "openai",
  },
  {
    id: "google_first",
    label: "Google first",
    sub: "Every agent uses Gemini (via CLI or AI Studio API key).",
    requires: "google",
  },
];

function ProviderStrategyPicker({
  strategy,
  onStrategyChange,
  providers,
  disabled,
}: {
  strategy: ProviderStrategy;
  onStrategyChange: (s: ProviderStrategy) => void;
  providers: ProvidersResponse | undefined;
  disabled: boolean;
}) {
  const avail = providers?.availability;
  const currentId = typeof strategy === "string" ? strategy : "mixed";

  const isEnabled = (opt: StrategyOption): boolean => {
    if (!avail) return true; // Loading — don't grey out prematurely
    if (opt.requires === "any") return avail.anyConfigured;
    const fam = avail[opt.requires];
    return fam.api || fam.cli;
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          How should your agents run?
        </label>
        {providers && !avail?.anyConfigured && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
            <div>
              No AI provider keys detected. Set <code className="font-mono">ANTHROPIC_API_KEY</code>,{" "}
              <code className="font-mono">OPENAI_API_KEY</code>, or install the{" "}
              <code className="font-mono">claude</code> / <code className="font-mono">codex</code> / <code className="font-mono">gemini</code> CLI before spawning.
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-2">
        {STRATEGY_OPTIONS.map((opt) => {
          const enabled = isEnabled(opt);
          const active = currentId === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled || !enabled}
              onClick={() => onStrategyChange(opt.id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                active
                  ? "border-[color:color-mix(in_oklch,var(--brand)_55%,var(--border))] bg-[color:color-mix(in_oklch,var(--brand)_8%,transparent)]"
                  : "border-border bg-background/40",
                enabled && !active
                  ? "hover:border-[color:color-mix(in_oklch,var(--brand)_40%,var(--border))]"
                  : "",
                !enabled && "opacity-50 cursor-not-allowed",
              )}
            >
              <div
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  active
                    ? "border-[var(--brand)] bg-[var(--brand)]"
                    : "border-border bg-background",
                )}
              >
                {active && <CheckCircle2 className="h-3 w-3 text-[var(--primary-foreground,white)]" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{opt.label}</span>
                  {!enabled && providers && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Not configured
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{opt.sub}</div>
              </div>
            </button>
          );
        })}
      </div>

      {providers && avail && (
        <ProviderAvailabilityRow providers={providers} />
      )}
    </div>
  );
}

function ProviderAvailabilityRow({ providers }: { providers: ProvidersResponse }) {
  const items = providers.providers.map((p) => {
    const anyAvail = p.api.configured || p.cli.installed;
    const label =
      p.family === "anthropic" ? "Claude"
      : p.family === "openai" ? "OpenAI"
      : "Gemini";
    const detail =
      p.cli.installed && p.cli.authed ? "CLI + auth"
      : p.cli.installed ? "CLI installed"
      : p.api.configured ? "API key"
      : "not set up";
    return { family: p.family, label, detail, ok: anyAvail };
  });
  return (
    <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground pt-1">
      <span className="uppercase tracking-[0.14em] font-medium">Detected:</span>
      {items.map((it) => (
        <span
          key={it.family}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 border",
            it.ok
              ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
              : "border-border text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "inline-block h-1 w-1 rounded-full",
              it.ok ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          <span className="font-medium">{it.label}</span>
          <span className="text-muted-foreground">· {it.detail}</span>
        </span>
      ))}
    </div>
  );
}
