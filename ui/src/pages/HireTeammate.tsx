import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi, type HireProposal } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { HireProposalCard } from "../components/HireProposalCard";
import { Button } from "@/components/ui/button";
import { agentUrl } from "../lib/utils";
import type { Agent } from "@founderos/shared";

type Stage = "intent" | "loading" | "review";

export function HireTeammate() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [stage, setStage] = useState<Stage>("intent");
  const [intent, setIntent] = useState(searchParams.get("intent") ?? "");
  const [proposal, setProposal] = useState<HireProposal | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Team", href: "/agents/all" }, { label: "Hire" }]);
  }, [setBreadcrumbs]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const draftMutation = useMutation({
    mutationFn: async (params: { intent: string; previousDraft?: HireProposal }) => {
      const controller = new AbortController();
      abortRef.current = controller;
      return agentsApi.draftHireProposal(selectedCompanyId!, params);
    },
    onMutate: () => {
      setDraftError(null);
      setStage("loading");
    },
    onSuccess: (data) => {
      setProposal(data);
      setStage("review");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to draft proposal. Try again.";
      setDraftError(message);
      setStage("intent");
    },
  });

  const hireMutation = useMutation({
    mutationFn: async (p: HireProposal) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return agentsApi.create(selectedCompanyId, {
        name: p.name,
        role: p.role,
        title: p.title,
        briefMarkdown: p.briefMarkdown,
        budgetMonthlyCents: p.monthlyCompCents,
        reportsTo: p.reportsTo
          ? (agents.find((a: Agent) => a.name === p.reportsTo)?.id ?? null)
          : null,
      });
    },
    onSuccess: (agent) => {
      navigate(agentUrl(agent));
    },
  });

  function handleSubmitIntent() {
    if (!intent.trim() || !selectedCompanyId) return;
    draftMutation.mutate({ intent: intent.trim() });
  }

  function handleRedraft() {
    if (!proposal || !selectedCompanyId) return;
    draftMutation.mutate({ intent: intent.trim(), previousDraft: proposal });
  }

  function handleEditIntent() {
    setStage("intent");
    setProposal(null);
  }

  function handleCancel() {
    abortRef.current?.abort();
    draftMutation.reset();
    setStage("intent");
  }

  if (!selectedCompanyId) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Select a company first.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-8 px-4 space-y-10">
      {/* ─── Stage: Intent ─── */}
      {(stage === "intent" || stage === "loading") && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Hire a teammate
            </div>
            <h1 className="font-display text-[32px] leading-[1.05] tracking-tight text-foreground">
              Who do you want to hire?
            </h1>
            <p className="text-sm text-muted-foreground">
              Describe the role in plain English. Your CEO teammate drafts the rest.
            </p>
          </header>

          <textarea
            className="w-full min-h-[120px] resize-y rounded-md border border-border bg-background/60 px-4 py-3 text-sm leading-relaxed focus:outline-none focus:border-[var(--brand)] transition-colors"
            placeholder="e.g. 'I need a head of growth to run outbound to SaaS founders on LinkedIn' or 'A CFO to watch burn and pressure-test pricing'"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={stage === "loading"}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmitIntent();
            }}
            autoFocus
          />

          {draftError && (
            <p className="text-sm text-destructive">{draftError}</p>
          )}

          {stage === "loading" ? (
            <div className="flex items-center gap-3">
              <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/20 border-t-[var(--brand)] animate-spin shrink-0" />
              <span className="text-sm text-muted-foreground">Your CEO teammate is drafting…</span>
              <button
                className="ml-auto text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          ) : (
            <Button
              size="lg"
              onClick={handleSubmitIntent}
              disabled={!intent.trim() || draftMutation.isPending}
            >
              Draft this hire
            </Button>
          )}
        </div>
      )}

      {/* ─── Stage: Review ─── */}
      {stage === "review" && proposal && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Review proposal
            </div>
            <h1 className="font-display text-[28px] leading-[1.1] tracking-tight text-foreground">
              Your CEO drafted a hire
            </h1>
            <p className="text-sm text-muted-foreground">
              Review and edit the proposal below, then confirm the hire.
            </p>
          </header>

          {hireMutation.isError && (
            <p className="text-sm text-destructive">
              {hireMutation.error instanceof Error
                ? hireMutation.error.message
                : "Failed to create teammate. Try again."}
            </p>
          )}

          <HireProposalCard
            key={proposal.name + proposal.rationale}
            proposal={proposal}
            agents={agents}
            onHire={(p) => hireMutation.mutate(p)}
            onRedraft={handleRedraft}
            onEditIntent={handleEditIntent}
            isHiring={hireMutation.isPending || draftMutation.isPending}
          />
        </div>
      )}
    </div>
  );
}
