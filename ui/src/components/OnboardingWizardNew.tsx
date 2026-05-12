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
  // Fetch the full template for the selected built-in so demand + roster
  // preview can use the same code path as imported templates.
  const fullTemplateQuery = useQuery({
    queryKey: ["templates", "get", selectedId],
    queryFn: () => templatesApi.get(selectedId!),
    enabled: !!selectedId,
  });

  /**
   * Whichever template is active — inline import wins, falls back to the
   * fetched built-in. Null until the user has picked something.
   */
  const activeTemplate: CompanyTemplate | null =
    importedTemplate ?? fullTemplateQuery.data ?? null;

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
    <div className="mx-auto w-full max-w-4xl px-6 py-12 md:px-10 md:py-20">
      <WizardProgress currentStep={step} hasTemplate={!!selectedId} />

      {step === "welcome" && <WelcomeStep onNext={() => setStep("template")} />}

      {step === "template" && (
        <TemplateStep
          templates={templatesQuery.data ?? []}
          loading={templatesQuery.isLoading}
          selectedId={selectedId}
          importedTemplate={importedTemplate}
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
          }}
          onClearImported={() => {
            setImportedTemplate(null);
            setCompanyName("");
          }}
          onContinueImported={() => setStep("providers")}
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
          activeTemplate={activeTemplate}
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

/**
 * Notion-style minimal step indicator. Instead of numbered-dot chain, we
 * show "Step N of M · <Label>" on the left plus a thin progress rail on
 * the right. Takes a lot less vertical space and reads like a toolbar.
 */
function WizardProgress({ currentStep, hasTemplate }: { currentStep: Step; hasTemplate: boolean }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "template", label: "Pick a starting team" },
    { id: "providers", label: "Connect an AI provider" },
    { id: "review", label: "Review & launch" },
  ];
  const idx = Math.max(0, steps.findIndex((s) => s.id === currentStep));
  const total = steps.length;
  const completed = currentStep === "review" && hasTemplate ? total : idx;
  const pct = Math.round((completed / (total - 1)) * 100);

  return (
    <div className="mb-12 flex items-center gap-6">
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground tabular-nums font-medium">
          {String(idx + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </span>
        <span className="text-sm font-medium text-foreground">{steps[idx]?.label}</span>
      </div>
      <div className="h-px flex-1 bg-border/80 relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-foreground/75 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Welcome step — editorial, left-aligned, Notion/Coda-style.
 *
 * We deliberately avoid the stock "centered gradient box" treatment.
 * The page carries the brand on typography (display serif for the
 * headline) and on a small structured checklist that reads like a
 * Notion database callout — it tells founders exactly what the next
 * four steps will cost them, in a professional register.
 */
function WelcomeStep({ onNext }: { onNext: () => void }) {
  const agenda: Array<{ n: string; label: string; sub: string }> = [
    { n: "01", label: "Pick a starting team", sub: "Three prebuilt org shapes or import your own JSON." },
    { n: "02", label: "Connect an AI provider", sub: "Claude, Codex, or Gemini — via CLI subscription or API." },
    { n: "03", label: "Review the roster", sub: "Confirm names, reports-to, and monthly spend caps." },
    { n: "04", label: "Launch", sub: "Your team goes live and begins its first shift." },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.15fr,1fr] gap-10 md:gap-16 items-start">
      <div>
        <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
          A new kind of company
        </div>
        <h1 className="mt-6 font-display text-5xl md:text-6xl leading-[1.02] tracking-tight text-foreground">
          Build a company.
          <br />
          <span className="font-display-italic text-[var(--brand)]">Staff it with AI.</span>
        </h1>
        <p className="mt-6 text-[15px] text-muted-foreground leading-[1.65] max-w-lg">
          FounderOS gives you a full operating team — a CEO, a CTO, a head of growth,
          an ops lead — running on the AI providers you already pay for.
          Everyone has a role, a budget, and a working shift.
        </p>
        <div className="mt-10 flex items-center gap-4">
          <Button size="lg" onClick={onNext} className="gap-2 rounded-md">
            Start setup
            <ArrowRight className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">About 5 minutes</span>
        </div>
      </div>

      <div className="border-l border-border/80 pl-6 md:pl-10">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-5">
          What you&apos;ll do
        </div>
        <ol className="space-y-5">
          {agenda.map((item) => (
            <li key={item.n} className="flex items-start gap-4">
              <span className="text-[11px] font-medium text-muted-foreground tabular-nums mt-[3px] w-5 shrink-0">
                {item.n}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{item.label}</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground leading-[1.55]">
                  {item.sub}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function TemplateStep({
  templates,
  loading,
  selectedId,
  importedTemplate,
  onSelect,
  onImportedTemplate,
  onClearImported,
  onContinueImported,
  onBack,
}: {
  templates: TemplateSummary[];
  loading: boolean;
  selectedId: string | null;
  importedTemplate: CompanyTemplate | null;
  onSelect: (id: string, t: TemplateSummary) => void;
  /** Fired when a user uploads a .template.json file. Does NOT advance the step. */
  onImportedTemplate: (template: CompanyTemplate) => void;
  onClearImported: () => void;
  onContinueImported: () => void;
  onBack: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // When a template has been imported, swap the grid for an inline preview
  // so the user can review what's about to spawn before committing.
  if (importedTemplate) {
    return (
      <ImportedTemplatePreview
        template={importedTemplate}
        onContinue={onContinueImported}
        onDiscard={onClearImported}
      />
    );
  }

  return (
    <div>
      <div className="mb-10">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Step 01 · Starting team
        </div>
        <h2 className="font-display text-4xl md:text-[2.75rem] leading-[1.05] tracking-tight text-foreground">
          Pick the team you want to start with.
        </h2>
        <p className="mt-3 max-w-xl text-[14px] text-muted-foreground leading-[1.65]">
          Each option ships a complete org: a CEO, direct reports, goals, projects, and
          a starter backlog. Everything is editable once you&apos;re in.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id, t)}
            className={cn(
              "group flex flex-col text-left rounded-lg border bg-card p-5 transition-all",
              selectedId === t.id
                ? "border-foreground/40 shadow-sm"
                : "border-border hover:border-foreground/25 hover:shadow-sm",
            )}
          >
            <div className="flex items-center gap-2 mb-5">
              <span className="text-2xl leading-none">{t.icon}</span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {t.category.replace(/_/g, " ")}
              </span>
            </div>
            <h3 className="text-[17px] font-semibold text-foreground mb-1 tracking-tight">{t.name}</h3>
            <p className="text-[13px] text-muted-foreground leading-snug mb-4">{t.tagline}</p>
            <p className="text-[13px] text-foreground/75 leading-[1.6] mb-5 line-clamp-3">
              {t.summary}
            </p>
            <div className="mt-auto pt-4 border-t border-border/70 flex items-center justify-between text-[11px] text-muted-foreground">
              <StatBadge icon={Users} label={`${t.agentCount}`} />
              <StatBadge icon={Flag} label={`${t.goalCount}`} />
              <StatBadge icon={Target} label={`${t.projectCount}`} />
              <ArrowRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-foreground" />
            </div>
          </button>
        ))}
      </div>
      <div className="mt-10 flex items-center justify-between gap-3 flex-wrap">
        <Button type="button" variant="ghost" onClick={onBack} className="gap-1.5 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <TemplateImportButton onImported={onImportedTemplate} />
      </div>
    </div>
  );
}

/**
 * Preview panel shown immediately after a user uploads a `.template.json`.
 * Gives them a last chance to inspect the roster (agents + goal/project counts)
 * before moving on to the providers step. Prevents "wrong file" regret-spawns.
 */
function ImportedTemplatePreview({
  template,
  onContinue,
  onDiscard,
}: {
  template: CompanyTemplate;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  // Collapse long agent rosters to a preview + "show all" toggle so the
  // panel doesn't become a wall of text for 20-agent templates.
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_COUNT = 6;
  const agents = template.agents;
  const visibleAgents = expanded ? agents : agents.slice(0, PREVIEW_COUNT);
  const remaining = agents.length - visibleAgents.length;

  return (
    <div>
      <div className="mb-10">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Imported template
        </div>
        <h2 className="font-display text-4xl md:text-[2.75rem] leading-[1.05] tracking-tight text-foreground">
          Does this look right?
        </h2>
        <p className="mt-3 max-w-xl text-[14px] text-muted-foreground leading-[1.65]">
          Review the roster before we spin up a company from this file. Nothing is created yet.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-5">
        <div className="flex items-start gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-xl shrink-0"
            style={{ background: "color-mix(in oklch, var(--brand) 14%, transparent)" }}
          >
            {template.icon ?? "📂"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold text-foreground">{template.name}</div>
            {template.tagline && (
              <div className="text-sm text-muted-foreground mt-0.5">{template.tagline}</div>
            )}
            {template.summary && (
              <div className="text-[13px] text-muted-foreground/90 leading-relaxed mt-2">
                {template.summary}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 pt-3 border-t border-border">
          <MetaRow label="Agents" value={template.agents.length.toString()} />
          <MetaRow label="Goals" value={template.goals.length.toString()} />
          <MetaRow label="Projects" value={template.projects.length.toString()} />
          <MetaRow label="Issues" value={template.issues.length.toString()} />
        </div>

        <div className="pt-3 border-t border-border">
          <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground mb-2">Agent roster</div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-background/30">
            {visibleAgents.map((a) => (
              <li key={a.key} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {a.name}
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">{a.title}</span>
                  </div>
                  {a.reportsTo && (
                    <div className="text-[11px] text-muted-foreground truncate">
                      reports to <code className="font-mono">{a.reportsTo}</code>
                    </div>
                  )}
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                  ${a.budgetUsd}
                </span>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-xs text-[var(--brand)] font-medium hover:underline"
            >
              Show {remaining} more {remaining === 1 ? "agent" : "agents"}
            </button>
          )}
          {expanded && agents.length > PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Collapse
            </button>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onDiscard} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Choose a different template
        </Button>
        <Button type="button" onClick={onContinue} className="gap-1.5">
          Use this template <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function StatBadge({ icon: Icon, label }: { icon: typeof Users; label: string }) {
  return (
    <div className="flex items-center gap-1.5 tabular-nums">
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}

function ProvidersStep({
  providers,
  strategy,
  onStrategyChange,
  onBack,
  onNext,
  activeTemplate,
}: {
  providers: ProvidersResponse | undefined;
  strategy: ProviderStrategy;
  onStrategyChange: (s: ProviderStrategy) => void;
  onBack: () => void;
  onNext: () => void;
  /** The active template (imported or fetched built-in). Null while built-in loads. */
  activeTemplate: CompanyTemplate | null;
}) {
  const ready = providers?.availability.anyConfigured ?? false;

  // Count how many agents prefer each family as their top-priority provider,
  // so each family row can be tagged with "N agents" chip. Works uniformly
  // for imported templates and fetched built-ins.
  const demand = activeTemplate ? computeFamilyDemand(activeTemplate) : null;

  // Count unmet demand: agents whose top-priority family isn't configured and
  // whose fallback families (if any) are also unconfigured. "mixed" strategy
  // means the spawner will fall back, but the user should still know.
  const gapCount = activeTemplate && providers
    ? countUnmetDemand(activeTemplate, providers)
    : 0;

  return (
    <div>
      <div className="mb-10">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Step 02 · AI provider
        </div>
        <h2 className="font-display text-4xl md:text-[2.75rem] leading-[1.05] tracking-tight text-foreground">
          Who runs the work?
        </h2>
        <p className="mt-3 max-w-xl text-[14px] text-muted-foreground leading-[1.65]">
          Bring whichever provider you already use — Claude, Codex, or Gemini — via a
          local CLI subscription or a direct API key. You can mix providers per teammate later.
        </p>
      </div>

      {activeTemplate && gapCount > 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
          <div className="font-medium text-foreground">
            {gapCount} {gapCount === 1 ? "agent prefers" : "agents prefer"} a provider you haven&apos;t configured.
          </div>
          <div className="mt-0.5 text-muted-foreground">
            With mixed strategy they&apos;ll fall back automatically. Configure more providers below
            for exact template behavior.
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        {(["anthropic", "openai", "google"] as const).map((fam) => {
          const report = providers?.providers.find((p) => p.family === fam);
          const ok = report ? report.api.configured || report.cli.installed : false;
          const meta = FAMILY_INFO[fam];
          const demandCount = demand?.[fam] ?? 0;
          return (
            <div key={fam} className="flex items-center gap-3">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-base"
                style={{ background: ok ? meta.bg : "color-mix(in oklch, var(--muted) 40%, transparent)" }}
              >
                {meta.icon}
              </span>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  {meta.label}
                  {demandCount > 0 && (
                    <span className="text-[10px] uppercase tracking-[0.1em] rounded-full px-1.5 py-0.5 font-semibold bg-[color:color-mix(in_oklch,var(--brand)_14%,transparent)] text-[var(--brand)]">
                      {demandCount} {demandCount === 1 ? "agent" : "agents"}
                    </span>
                  )}
                </div>
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
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-2">
          Step 04 · Launch
        </div>
        <h2 className="font-display text-4xl md:text-[2.75rem] leading-[1.05] tracking-tight text-foreground">
          Ready when you are.
        </h2>
        <p className="mt-3 text-[14px] text-muted-foreground leading-[1.65] max-w-lg">
          Confirm the name and we&apos;ll spin up your company — agents, org chart, goals,
          and a starter backlog, in one atomic transaction.
        </p>
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
          <MetaRow label="AI setup" value={strategyLabel} />
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
 * Count how many agents in the template prefer each provider family as their
 * top-priority choice. Agents without an explicit `provider.families` fall back
 * to anthropic (matches the server-side default in adapter-resolver).
 */
function computeFamilyDemand(template: CompanyTemplate): Record<"anthropic" | "openai" | "google", number> {
  const out: Record<"anthropic" | "openai" | "google", number> = {
    anthropic: 0,
    openai: 0,
    google: 0,
  };
  for (const a of template.agents) {
    const top = a.provider?.families?.[0] ?? "anthropic";
    if (top === "anthropic" || top === "openai" || top === "google") {
      out[top] += 1;
    }
  }
  return out;
}

/**
 * Count agents whose entire preferred-families chain has zero configured
 * providers. These are agents that will fall back to "any configured" family
 * under mixed strategy — worth flagging so the user can decide.
 */
function countUnmetDemand(template: CompanyTemplate, providers: ProvidersResponse): number {
  const configured = new Set<string>();
  for (const p of providers.providers) {
    if (p.api.configured || p.cli.installed) configured.add(p.family);
  }
  let unmet = 0;
  for (const a of template.agents) {
    const families = a.provider?.families ?? ["anthropic"];
    const hasAny = families.some((f) => configured.has(f));
    if (!hasAny) unmet += 1;
  }
  return unmet;
}

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
