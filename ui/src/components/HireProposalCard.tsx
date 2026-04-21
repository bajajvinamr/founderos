import { useState } from "react";
import type { Agent } from "@founderos/shared";
import type { HireProposal } from "../api/agents";
import { ReportsToPicker } from "./ReportsToPicker";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { AGENT_ROLE_LABELS } from "@founderos/shared";
import { RefreshCw, UserCheck } from "lucide-react";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

const DEPARTMENT_LABELS: Record<string, string> = {
  "chief-of-staff": "Chief of Staff",
  growth: "Growth",
  content: "Content",
  crm: "CRM",
  finance: "Finance",
  engineering: "Engineering",
  ops: "Operations",
};

interface HireProposalCardProps {
  proposal: HireProposal;
  agents: Agent[];
  onHire: (proposal: HireProposal) => void;
  onRedraft: () => void;
  onEditIntent: () => void;
  isHiring: boolean;
}

/**
 * Renders a drafted teammate proposal for founder review.
 * All fields are editable inline before confirming the hire.
 */
export function HireProposalCard({
  proposal,
  agents,
  onHire,
  onRedraft,
  onEditIntent,
  isHiring,
}: HireProposalCardProps) {
  const [draft, setDraft] = useState<HireProposal>(proposal);

  // When the parent gives us a new proposal (redraft), reset local state
  // This works because the parent re-mounts or passes a new key.

  const initial = draft.name.charAt(0).toUpperCase();
  const isFallback = draft.rationale.startsWith("(Fallback:");

  function update<K extends keyof HireProposal>(key: K, value: HireProposal[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // Find the reportsTo agent id from the name
  const reportsToAgent = draft.reportsTo
    ? agents.find((a) => a.name === draft.reportsTo) ?? null
    : null;

  function handleReportsToChange(agentId: string | null) {
    const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
    update("reportsTo", agent?.name ?? null);
  }

  return (
    <div className="space-y-6">
      {/* Header — avatar + name + title */}
      <div className="flex items-start gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent text-xl font-semibold text-foreground">
          {initial}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              className="text-xl font-semibold bg-transparent border-b border-transparent hover:border-border focus:border-[var(--brand)] outline-none transition-colors"
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
              aria-label="Teammate name"
            />
            <span
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide",
                "border-[var(--brand)] text-[color:var(--brand)] bg-[color:color-mix(in_oklch,var(--brand)_8%,transparent)]",
              )}
            >
              {roleLabels[draft.role] ?? draft.role}
            </span>
            <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {DEPARTMENT_LABELS[draft.department] ?? draft.department}
            </span>
          </div>
          <input
            className="text-sm text-muted-foreground bg-transparent border-b border-transparent hover:border-border focus:border-[var(--brand)] outline-none transition-colors w-full"
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            aria-label="Job title"
          />
        </div>
      </div>

      {/* Reports to */}
      <div className="space-y-1">
        <label className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Reports to
        </label>
        <ReportsToPicker
          agents={agents}
          value={reportsToAgent?.id ?? null}
          onChange={handleReportsToChange}
        />
      </div>

      {/* Brief */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Role brief
        </label>
        <textarea
          className={cn(
            "w-full min-h-[220px] resize-y rounded-md border border-border bg-background/60 px-3 py-2.5",
            "text-sm leading-relaxed font-mono text-foreground",
            "focus:outline-none focus:border-[var(--brand)] transition-colors",
          )}
          value={draft.briefMarkdown}
          onChange={(e) => update("briefMarkdown", e.target.value)}
          aria-label="Role brief (markdown)"
        />
      </div>

      {/* Monthly comp */}
      <div className="space-y-1">
        <label className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Monthly comp (USD)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input
            type="number"
            min={0}
            step={10}
            className={cn(
              "w-28 rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm",
              "focus:outline-none focus:border-[var(--brand)] transition-colors",
            )}
            value={Math.round(draft.monthlyCompCents / 100)}
            onChange={(e) => {
              const val = Number.parseFloat(e.target.value);
              if (!Number.isNaN(val)) update("monthlyCompCents", Math.round(val * 100));
            }}
            aria-label="Monthly compensation in dollars"
          />
          <span className="text-xs text-muted-foreground">/mo</span>
        </div>
      </div>

      {/* Rationale */}
      {draft.rationale && (
        <p className={cn("text-xs rounded-md p-3 border", isFallback ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400" : "border-border bg-muted/30 text-muted-foreground")}>
          <span className="font-medium">Why now: </span>
          {draft.rationale}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <Button
          size="lg"
          className="flex-1"
          onClick={() => onHire(draft)}
          disabled={isHiring}
        >
          <UserCheck className="h-4 w-4 mr-2" />
          {isHiring ? "Hiring…" : "Hire"}
        </Button>
        <Button variant="outline" size="lg" onClick={onRedraft} disabled={isHiring}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Re-draft
        </Button>
      </div>

      <div className="text-center">
        <button
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          onClick={onEditIntent}
          disabled={isHiring}
        >
          Edit my intent
        </button>
      </div>
    </div>
  );
}
