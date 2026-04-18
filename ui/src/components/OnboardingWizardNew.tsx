import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import type { TemplateSummary, CompanyTemplate } from "@founderos/shared";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Sparkles,
  Users,
  Target,
  Flag,
  Key,
  Upload,
} from "lucide-react";
import {
  templatesApi,
  type ProviderStrategy,
  type ProvidersResponse,
} from "@/api/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";

type Step = "welcome" | "template" | "providers" | "review";

/**
 * 4-step onboarding wizard for first-run users.
 *
 *   1. welcome   — brief intro + single CTA
 *   2. template  — pick a starter template (replaces old single-step picker)
 *   3. providers — confirm at least one AI provider is configured
 *   4. review    — final summary + spawn
 *
 * Matches the PRD Day-8 "Onboarding wizard" deliverable. Still cleanly
 * collapses to the 2-step path if a user navigates directly with state.
 */
export function OnboardingWizardNew() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const [step, setStep] = useState<Step>("welcome");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importedTemplate, setImportedTemplate] = useState<CompanyTemplate | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [strategy, setStrategy] = useState<ProviderStrategy>("mixed");

  const templatesQuery = useQuery({
    queryKey: ["templates", "list"],
    queryFn: () => templatesApi.list(),
  });
  const providersQuery = useQuery({
    queryKey: ["providers", "status"],
    queryFn: () => templatesApi.providers(),
    refetchInterval: step === "providers" ? 5_000 : false,
  });

  const spawnMutation = useMutation({
    mutationFn: () =>
      templatesApi.spawn(
        importedTemplate
          ? {
              inlineTemplate: importedTemplate,
              companyName: companyName.trim() || undefined,
              providerStrategy: strategy,
            }
          : {
              templateId: selectedId!,
              companyName: companyName.trim() || undefined,
              providerStrategy: strategy,
            },
      ),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(data.companyId);
      navigate("/dashboard");
    },
  });

  // For the review step, build a summary from whichever source is active.
  const selectedTemplate: TemplateSummary | null = importedTemplate
    ? {
        id: importedTemplate.id,
        name: importedTemplate.name,
        tagline: importedTemplate.tagline ?? "Imported template",
        summary: importedTemplate.summary ?? "",
        icon: importedTemplate.icon ?? "📂",
        category: importedTemplate.category ?? "custom",
        agentCount: importedTemplate.agents.length,
        goalCount: importedTemplate.goals.length,
        projectCount: importedTemplate.projects.length,
      }
    : selectedId
      ? templatesQuery.data?.find((t) => t.id === selectedId) ?? null
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:py-14">
      <WizardProgress currentStep={step} hasTemplate={!!selectedId} />

      {step === "welcome" && <WelcomeStep onNext={() => setStep("template")} />}

      {step === "template" && (
        <TemplateStep
          templates={templatesQuery.data ?? []}
          loading={templatesQuery.isLoading}
          selectedId={selectedId}
          onSelect={(id, t) => {
            setImportedTemplate(null);
            setSelectedId(id);
            setCompanyName(t.name);
            setStep("providers");
          }}
          onImportedTemplate={(t) => {
            setImportedTemplate(t);
            setSelectedId(null);
            setCompanyName(t.name);
            setStep("providers");
          }}
          onBack={() => setStep("welcome")}
        />
      )}

      {step === "providers" && selectedTemplate && (
        <ProvidersStep
          providers={providersQuery.data}
          strategy={strategy}
          onStrategyChange={setStrategy}
          onBack={() => setStep("template")}
          onNext={() => setStep("review")}
        />
      )}

      {step === "review" && selectedTemplate && (
        <ReviewStep
          template={selectedTemplate}
          companyName={companyName}
          onCompanyNameChange={setCompanyName}
          strategy={strategy}
          providers={providersQuery.data}
          onBack={() => setStep("providers")}
          onLaunch={() => spawnMutation.mutate()}
          isPending={spawnMutation.isPending}
          error={spawnMutation.error instanceof Error ? spawnMutation.error.message : null}
        />
      )}
    </div>
  );
}

function WizardProgress({ currentStep, hasTemplate }: { currentStep: Step; hasTemplate: boolean }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "template", label: "Template" },
    { id: "providers", label: "Providers" },
    { id: "review", label: "Launch" },
  ];
  const idx = steps.findIndex((s) => s.id === currentStep);

  return (
    <div className="mb-10 flex items-center gap-2">
      {steps.map((s, i) => {
        const done = i < idx || (i === idx && currentStep === "review" && hasTemplate);
        const active = s.id === currentStep;
        return (
          <div key={s.id} className="flex items-center gap-2 flex-1">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold border-2 transition-colors",
                active
                  ? "bg-[var(--brand)] border-[var(--brand)] text-[var(--primary-foreground,white)]"
                  : done
                    ? "bg-[var(--brand)]/20 border-[var(--brand)]/50 text-[var(--brand)]"
                    : "bg-background border-border text-muted-foreground",
              )}
            >
              {done ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
            </div>
            <span className={cn("text-[11px] uppercase tracking-[0.12em] font-medium", active ? "text-foreground" : "text-muted-foreground")}>
              {s.label}
            </span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-border ml-1" />}
          </div>
        );
      })}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-border">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklch, var(--brand) 18%, var(--background)) 0%, var(--background) 55%)",
        }}
      />
      <div className="relative px-8 py-14 md:px-12 md:py-20 text-center">
        <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand)]">
          <Sparkles className="h-3.5 w-3.5" />
          Welcome to FounderOS
        </div>
        <h1 className="mt-4 text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05] text-foreground">
          Let&apos;s bring your{" "}
          <span className="text-[var(--brand)]">AI company</span> to life.
        </h1>
        <p className="mt-5 mx-auto max-w-lg text-base text-muted-foreground leading-relaxed">
          We&apos;ll walk you through four steps: pick a template, confirm your AI providers,
          review the roster, and launch. You&apos;ll have a fully-staffed company running
          in under five minutes.
        </p>
        <Button size="lg" onClick={onNext} className="mt-8 gap-2">
          Get started <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function TemplateStep({
  templates,
  loading,
  selectedId,
  onSelect,
  onImportedTemplate,
  onBack,
}: {
  templates: TemplateSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string, t: TemplateSummary) => void;
  /** Fired when a user uploads a .template.json file. */
  onImportedTemplate: (template: CompanyTemplate) => void;
  onBack: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Pick a starting template</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Each template spins up a company with pre-wired agents, goals, projects, and
          starter issues. You can customize everything after.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id, t)}
            className={cn(
              "flex flex-col text-left rounded-xl border p-5 transition-all",
              selectedId === t.id
                ? "border-[var(--brand)] bg-[color:color-mix(in_oklch,var(--brand)_8%,transparent)]"
                : "border-border bg-card hover:border-[color:color-mix(in_oklch,var(--brand)_45%,var(--border))]",
            )}
          >
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg mb-4 text-xl"
              style={{ background: "color-mix(in oklch, var(--brand) 14%, transparent)" }}
            >
              {t.icon}
            </div>
            <h3 className="text-base font-semibold text-foreground mb-1">{t.name}</h3>
            <p className="text-sm text-muted-foreground leading-snug mb-4">{t.tagline}</p>
            <p className="text-[13px] text-muted-foreground/90 leading-relaxed mb-4 line-clamp-3">
              {t.summary}
            </p>
            <div className="mt-auto flex items-center gap-3 text-[11px] text-muted-foreground">
              <StatBadge icon={Users} label={`${t.agentCount} agents`} />
              <StatBadge icon={Flag} label={`${t.goalCount} goals`} />
              <StatBadge icon={Target} label={`${t.projectCount} projects`} />
            </div>
          </button>
        ))}
      </div>
      <div className="mt-8 flex items-center justify-between gap-3 flex-wrap">
        <Button type="button" variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <TemplateImportButton onImported={onImportedTemplate} />
      </div>
    </div>
  );
}

function StatBadge({ icon: Icon, label }: { icon: typeof Users; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <Icon className="h-3 w-3" />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

function ProvidersStep({
  providers,
  strategy,
  onStrategyChange,
  onBack,
  onNext,
}: {
  providers: ProvidersResponse | undefined;
  strategy: ProviderStrategy;
  onStrategyChange: (s: ProviderStrategy) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const ready = providers?.availability.anyConfigured ?? false;
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Which AI provider?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Agents can run on Claude, OpenAI/Codex, or Gemini — using the local CLI of whichever
          you have subscribed, or a direct API key. You can mix + match per agent later.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        {(["anthropic", "openai", "google"] as const).map((fam) => {
          const report = providers?.providers.find((p) => p.family === fam);
          const ok = report ? report.api.configured || report.cli.installed : false;
          const meta = FAMILY_INFO[fam];
          return (
            <div key={fam} className="flex items-center gap-3">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-base"
                style={{ background: ok ? meta.bg : "color-mix(in oklch, var(--muted) 40%, transparent)" }}
              >
                {meta.icon}
              </span>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">{meta.label}</div>
                <div className="text-[11px] text-muted-foreground">
                  {ok ? (
                    <>
                      {report?.cli.installed ? "CLI installed · " : ""}
                      {report?.api.configured ? "API key set" : "ready"}
                    </>
                  ) : (
                    <>Not configured</>
                  )}
                </div>
              </div>
              {ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <a
                  href="/instance/settings/providers"
                  className="text-xs text-[var(--brand)] font-medium hover:underline inline-flex items-center gap-1"
                >
                  <Key className="h-3 w-3" />
                  Add key
                </a>
              )}
            </div>
          );
        })}
      </div>

      {ready ? (
        <div className="mt-6">
          <label className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground mb-2 block">
            Routing strategy
          </label>
          <div className="grid grid-cols-2 gap-2">
            {STRATEGIES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onStrategyChange(opt.id)}
                className={cn(
                  "flex flex-col items-start text-left rounded-lg border p-3 transition-colors",
                  strategy === opt.id
                    ? "border-[var(--brand)] bg-[color:color-mix(in_oklch,var(--brand)_8%,transparent)]"
                    : "border-border bg-background/40 hover:border-[color:color-mix(in_oklch,var(--brand)_40%,var(--border))]",
                )}
              >
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
                <span className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{opt.sub}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <div className="font-medium text-foreground">You need at least one AI provider to continue.</div>
          <div className="mt-1 text-muted-foreground text-xs leading-relaxed">
            The quickest path is the Claude Code CLI — if you have a Claude subscription,
            run <code className="font-mono">claude /login</code> in your terminal, then
            come back. This page auto-refreshes every 5 seconds.
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button type="button" onClick={onNext} disabled={!ready} className="gap-1.5">
          Continue <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ReviewStep({
  template,
  companyName,
  onCompanyNameChange,
  strategy,
  providers,
  onBack,
  onLaunch,
  isPending,
  error,
}: {
  template: TemplateSummary;
  companyName: string;
  onCompanyNameChange: (v: string) => void;
  strategy: ProviderStrategy;
  providers: ProvidersResponse | undefined;
  onBack: () => void;
  onLaunch: () => void;
  isPending: boolean;
  error: string | null;
}) {
  const strategyLabel =
    typeof strategy === "string"
      ? STRATEGIES.find((s) => s.id === strategy)?.label ?? strategy
      : "Custom override";
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Review &amp; launch</h2>
        <p className="mt-2 text-sm text-muted-foreground">One last look before we spin up your company.</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-xl"
            style={{ background: "color-mix(in oklch, var(--brand) 14%, transparent)" }}
          >
            {template.icon}
          </div>
          <div className="flex-1">
            <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Template</div>
            <div className="text-base font-semibold text-foreground">{template.name}</div>
            <div className="text-sm text-muted-foreground mt-0.5">{template.tagline}</div>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="company-name" className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Company name
          </label>
          <Input
            id="company-name"
            value={companyName}
            onChange={(e) => onCompanyNameChange(e.target.value)}
            disabled={isPending}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border">
          <MetaRow label="Agents" value={template.agentCount.toString()} />
          <MetaRow label="Goals" value={template.goalCount.toString()} />
          <MetaRow label="Projects" value={template.projectCount.toString()} />
          <MetaRow label="Provider strategy" value={strategyLabel} />
        </div>

        {providers && providers.storedKeys.length > 0 && (
          <div className="pt-3 border-t border-border">
            <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Configured keys</div>
            <div className="flex items-center gap-2 flex-wrap">
              {providers.storedKeys.map((k) => (
                <span key={`${k.family}:${k.executionMode}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  {k.family}
                  <code className="font-mono">{k.keyHint}</code>
                </span>
              ))}
            </div>
          </div>
        )}

        {error && <div className="text-sm text-destructive pt-2">{error}</div>}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={isPending} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button type="button" size="lg" onClick={onLaunch} disabled={isPending || companyName.trim().length === 0} className="gap-2">
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Spinning up…
            </>
          ) : (
            <>
              Launch {companyName.trim() || template.name} <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-foreground mt-0.5">{value}</div>
    </div>
  );
}

const STRATEGIES: Array<{ id: "mixed" | "anthropic_first" | "openai_first" | "google_first"; label: string; sub: string }> = [
  { id: "mixed", label: "Mixed (recommended)", sub: "Each agent uses its template-preferred provider. Falls back automatically." },
  { id: "anthropic_first", label: "Claude first", sub: "Every agent on Anthropic Claude. Your subscription or API key." },
  { id: "openai_first", label: "OpenAI first", sub: "Every agent on GPT-5 / Codex. Subscription or API key." },
  { id: "google_first", label: "Gemini first", sub: "Every agent on Gemini. Subscription or API key." },
];

const FAMILY_INFO: Record<"anthropic" | "openai" | "google", { label: string; icon: string; bg: string }> = {
  anthropic: { label: "Anthropic Claude", icon: "🟠", bg: "color-mix(in oklch, #d97757 18%, transparent)" },
  openai: { label: "OpenAI Codex / GPT-5", icon: "🔵", bg: "color-mix(in oklch, #10a37f 18%, transparent)" },
  google: { label: "Google Gemini", icon: "🟢", bg: "color-mix(in oklch, #4285f4 18%, transparent)" },
};

/**
 * Upload a `.template.json` exported from another FounderOS instance.
 * Parses locally, validates the shape is at least plausible, and hands
 * off to the parent wizard which then goes to the providers + review
 * steps just like a built-in template.
 */
function TemplateImportButton({
  onImported,
}: {
  onImported: (template: CompanyTemplate) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <label className="cursor-pointer">
        <input
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            setError(null);
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const parsed = JSON.parse(text) as CompanyTemplate;
              if (
                !parsed ||
                typeof parsed !== "object" ||
                typeof parsed.id !== "string" ||
                !Array.isArray(parsed.agents) ||
                parsed.agents.length === 0
              ) {
                throw new Error("Not a valid FounderOS template JSON");
              }
              onImported(parsed);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to parse file");
            } finally {
              // Allow re-upload of the same filename
              e.target.value = "";
            }
          }}
        />
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-[color:color-mix(in_oklch,var(--brand)_45%,var(--border))] transition-colors">
          <Upload className="h-3.5 w-3.5" />
          Import template JSON…
        </span>
      </label>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  );
}
