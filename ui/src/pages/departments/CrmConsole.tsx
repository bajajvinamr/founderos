import { useSearchParams } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { useToast } from "../../context/ToastContext";
import { cn } from "../../lib/utils";
import { Plus, AlertTriangle } from "lucide-react";
import type { Agent } from "@founderos/shared";

// MOCK — Wave 5 replaces with real CRM service.

// ─── Types ───────────────────────────────────────────────────────────────────

type DealStage = "prospect" | "qualified" | "demo" | "trial" | "closed_won";

type CampaignStatus = "active" | "draft";

type CrmTab = "pipeline" | "campaigns" | "onboarding" | "churn";

const VALID_TABS: CrmTab[] = ["pipeline", "campaigns", "onboarding", "churn"];

function isValidTab(v: string | null): v is CrmTab {
  return VALID_TABS.includes(v as CrmTab);
}

interface Deal {
  id: string;
  company: string;
  acv: number; // annual value in dollars
  owner: string;
  stage: DealStage;
  source: string;
  chip: string; // stage-specific context line
  lastTouchDaysAgo: number;
}

interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  trigger: string;
  actions: string;
  peopleInFlow: number;
  openRate: number; // percent
  lastActivity: string; // human-readable
}

interface FunnelStep {
  label: string;
  count: number;
}

interface AtRiskAccount {
  id: string;
  company: string;
  acv: number;
  signal: string;
  daysAtRisk: number;
  assignee: string;
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_DEALS: Deal[] = [
  // Prospect (5)
  {
    id: "d-1",
    company: "Nova Studios",
    acv: 12000,
    owner: "CRM teammate",
    stage: "prospect",
    source: "YC founder",
    chip: "Replied 2d ago",
    lastTouchDaysAgo: 2,
  },
  {
    id: "d-2",
    company: "Harborside Labs",
    acv: 18000,
    owner: "CRM teammate",
    stage: "prospect",
    source: "Cold",
    chip: "Replied 5d ago",
    lastTouchDaysAgo: 5,
  },
  {
    id: "d-3",
    company: "Obsidian Stack",
    acv: 8000,
    owner: "CRM teammate",
    stage: "prospect",
    source: "Referral",
    chip: "Replied 1d ago",
    lastTouchDaysAgo: 1,
  },
  {
    id: "d-4",
    company: "Ledger AI",
    acv: 24000,
    owner: "CRM teammate",
    stage: "prospect",
    source: "Content lead",
    chip: "Replied 4d ago",
    lastTouchDaysAgo: 4,
  },
  {
    id: "d-5",
    company: "Pixel Kitchen",
    acv: 6000,
    owner: "CRM teammate",
    stage: "prospect",
    source: "LinkedIn",
    chip: "Replied 6d ago",
    lastTouchDaysAgo: 6,
  },
  // Qualified (4)
  {
    id: "d-6",
    company: "Atlas Health",
    acv: 36000,
    owner: "CRM teammate",
    stage: "qualified",
    source: "Inbound",
    chip: "Demo scheduled",
    lastTouchDaysAgo: 1,
  },
  {
    id: "d-7",
    company: "Current Capital",
    acv: 48000,
    owner: "CRM teammate",
    stage: "qualified",
    source: "Outbound",
    chip: "POC scoping",
    lastTouchDaysAgo: 2,
  },
  {
    id: "d-8",
    company: "Glass Co",
    acv: 15000,
    owner: "CRM teammate",
    stage: "qualified",
    source: "Referral",
    chip: "Security review",
    lastTouchDaysAgo: 3,
  },
  {
    id: "d-9",
    company: "Maple Data",
    acv: 22000,
    owner: "CRM teammate",
    stage: "qualified",
    source: "Content lead",
    chip: "Procurement review",
    lastTouchDaysAgo: 4,
  },
  // Demo (2)
  {
    id: "d-10",
    company: "Everbright",
    acv: 42000,
    owner: "CRM teammate",
    stage: "demo",
    source: "LinkedIn",
    chip: "Demo booked Friday 3pm",
    lastTouchDaysAgo: 1,
  },
  {
    id: "d-11",
    company: "Rookwood Systems",
    acv: 28000,
    owner: "CRM teammate",
    stage: "demo",
    source: "Outbound",
    chip: "Demo tomorrow 10am",
    lastTouchDaysAgo: 0,
  },
  // Trial (2)
  {
    id: "d-12",
    company: "Rook Coffee",
    acv: 9000,
    owner: "CRM teammate",
    stage: "trial",
    source: "Inbound",
    chip: "Trial day 4/14",
    lastTouchDaysAgo: 1,
  },
  {
    id: "d-13",
    company: "Midnight Audio",
    acv: 14000,
    owner: "CRM teammate",
    stage: "trial",
    source: "Referral",
    chip: "Trial day 9/14 · activation low",
    lastTouchDaysAgo: 0,
  },
  // Closed Won (1)
  {
    id: "d-14",
    company: "Wayfarer Press",
    acv: 18000,
    owner: "CRM teammate",
    stage: "closed_won",
    source: "Content lead",
    chip: "Signed last week",
    lastTouchDaysAgo: 7,
  },
];

const MOCK_CAMPAIGNS: Campaign[] = [
  {
    id: "c-1",
    name: "Onboarding drip",
    status: "active",
    trigger: "New signups",
    actions: "5 emails over 14 days",
    peopleInFlow: 42,
    openRate: 68,
    lastActivity: "2h ago",
  },
  {
    id: "c-2",
    name: "Activation nudge",
    status: "active",
    trigger: "Users stuck at step 2",
    actions: "1 email",
    peopleInFlow: 18,
    openRate: 51,
    lastActivity: "4h ago",
  },
  {
    id: "c-3",
    name: "Trial day 10 check-in",
    status: "active",
    trigger: "Trial users day 10",
    actions: "CEO outreach + product-usage summary",
    peopleInFlow: 6,
    openRate: 83,
    lastActivity: "1d ago",
  },
  {
    id: "c-4",
    name: "Churn rescue",
    status: "draft",
    trigger: "Cancelled last 30 days",
    actions: "3-email win-back",
    peopleInFlow: 4,
    openRate: 0,
    lastActivity: "3d ago",
  },
];

const MOCK_FUNNEL: FunnelStep[] = [
  { label: "Signup", count: 348 },
  { label: "Email verified", count: 312 },
  { label: "First action", count: 186 },
  { label: "Invited teammate", count: 42 },
  { label: "Paid", count: 7 },
];

const MOCK_ACTIVATION_BARS = [28, 34, 40, 38, 44, 50, 52, 48, 55, 60, 58, 62, 65, 70];

const MOCK_AT_RISK: AtRiskAccount[] = [
  {
    id: "ar-1",
    company: "Everbright",
    acv: 42000,
    signal: "No login since Apr 8",
    daysAtRisk: 11,
    assignee: "CRM teammate",
  },
  {
    id: "ar-2",
    company: "Current Capital",
    acv: 48000,
    signal: "Usage -68% this week",
    daysAtRisk: 4,
    assignee: "CRM teammate",
  },
  {
    id: "ar-3",
    company: "Rook Coffee",
    acv: 9000,
    signal: "Cancellation word detected in comments",
    daysAtRisk: 2,
    assignee: "CRM teammate",
  },
  {
    id: "ar-4",
    company: "Atlas Health",
    acv: 36000,
    signal: "No login in 21 days",
    daysAtRisk: 18,
    assignee: "CRM teammate",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatK(dollars: number): string {
  return `$${Math.round(dollars / 1000)}k`;
}

function columnDeals(stage: DealStage, deals: Deal[]): Deal[] {
  return deals.filter((d) => d.stage === stage);
}

function columnSum(deals: Deal[]): number {
  return deals.reduce((sum, d) => sum + d.acv, 0);
}

const STAGE_COLORS: Record<DealStage, string> = {
  prospect: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20",
  qualified: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20",
  demo: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border border-violet-500/20",
  trial: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20",
  closed_won: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20",
};

const STAGE_LABELS: Record<DealStage, string> = {
  prospect: "Prospect",
  qualified: "Qualified",
  demo: "Demo",
  trial: "Trial",
  closed_won: "Closed Won",
};

const PIPELINE_STAGES: DealStage[] = ["prospect", "qualified", "demo", "trial", "closed_won"];

// ─── Sub-components ───────────────────────────────────────────────────────────

function AvatarInitial({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground border border-border shrink-0">
      {initial}
    </span>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 flex flex-col gap-2 hover:border-foreground/20 transition-colors">
      {/* Company name */}
      <p className="text-[12px] font-semibold text-foreground leading-snug">{deal.company}</p>
      {/* ACV */}
      <p className="tabular-nums text-[11px] text-[var(--brand,theme(colors.teal.500))] font-medium">
        {formatK(deal.acv)} ARR
      </p>
      {/* Owner + last touch */}
      <div className="flex items-center gap-1.5">
        <AvatarInitial name={deal.owner} />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {deal.lastTouchDaysAgo === 0 ? "Today" : `${deal.lastTouchDaysAgo}d ago`}
        </span>
      </div>
      {/* Stage chip */}
      <span
        className={cn(
          "self-start inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium leading-none whitespace-nowrap",
          STAGE_COLORS[deal.stage],
        )}
      >
        {deal.chip}
      </span>
    </div>
  );
}

function KanbanColumn({
  stage,
  deals,
}: {
  stage: DealStage;
  deals: Deal[];
}) {
  const stageDeals = columnDeals(stage, deals);
  const total = columnSum(stageDeals);

  return (
    <div className="flex flex-col gap-2 min-w-[180px] flex-1">
      {/* Column header */}
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {STAGE_LABELS[stage]}
        </span>
        <span className="tabular-nums text-[10px] text-muted-foreground/70">
          {stageDeals.length} · {formatK(total)}
        </span>
      </div>
      {/* Cards */}
      <div className="flex flex-col gap-2">
        {stageDeals.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/50 h-16 flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground/40">Empty</span>
          </div>
        ) : (
          stageDeals.map((deal) => <DealCard key={deal.id} deal={deal} />)
        )}
      </div>
    </div>
  );
}

// ─── Pipeline tab ─────────────────────────────────────────────────────────────

function PipelineTab({
  deals,
  crmName,
  pushToast,
}: {
  deals: Deal[];
  crmName: string;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const totalWeighted = columnSum(deals);
  const avgAcv = deals.length > 0 ? Math.round(totalWeighted / deals.length) : 0;

  return (
    <div className="space-y-4">
      {/* Weighted pipeline banner */}
      <div className="rounded-md border border-border bg-card px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-[12px] text-muted-foreground tabular-nums">
          Pipeline:{" "}
          <span className="text-foreground font-semibold">{formatK(totalWeighted)} weighted</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="text-foreground font-semibold">{deals.length} deals</span>
          <span className="mx-2 text-muted-foreground/40">·</span>
          avg ACV <span className="text-foreground font-semibold">{formatK(avgAcv)}</span>
        </p>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-muted-foreground/60">
            Last sync: 12 min ago · HubSpot
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px] gap-1"
            onClick={() =>
              pushToast({ title: "Coming soon", body: "Deal creation ships in Wave 5." })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add deal
          </Button>
        </div>
      </div>

      {/* Kanban board */}
      <div className="overflow-x-auto snap-x pb-4">
        <div className="flex gap-3 min-w-max sm:min-w-0 sm:grid sm:grid-cols-5">
          {PIPELINE_STAGES.map((stage) => (
            <KanbanColumn key={stage} stage={stage} deals={deals} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Campaigns tab ────────────────────────────────────────────────────────────

function CampaignCard({
  campaign,
  pushToast,
}: {
  campaign: Campaign;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const isActive = campaign.status === "active";
  return (
    <div className="rounded-md border border-border bg-card px-4 py-4 flex flex-col gap-3 hover:border-foreground/20 transition-colors">
      {/* Name + status */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full shrink-0",
            isActive ? "bg-emerald-500" : "bg-amber-400",
          )}
        />
        <p className="text-sm font-semibold text-foreground">{campaign.name}</p>
        <span
          className={cn(
            "ml-auto text-[10px] font-medium uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-full border",
            isActive
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
          )}
        >
          {isActive ? "Active" : "Draft"}
        </span>
      </div>

      {/* Trigger → actions */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
        <span>{campaign.trigger}</span>
        <span className="text-foreground/40">→</span>
        <span className="text-foreground/70">{campaign.actions}</span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-[11px] tabular-nums">
        <span>
          <span className="text-foreground font-semibold">{campaign.peopleInFlow}</span>{" "}
          <span className="text-muted-foreground">in flow</span>
        </span>
        {campaign.openRate > 0 && (
          <span>
            <span className="text-foreground font-semibold">{campaign.openRate}%</span>{" "}
            <span className="text-muted-foreground">open</span>
          </span>
        )}
        <span className="text-muted-foreground ml-auto">Active {campaign.lastActivity}</span>
      </div>

      {/* Ghost action buttons */}
      <div className="flex items-center gap-1.5 pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => pushToast({ title: "Edit", body: "Campaign editing ships in Wave 5." })}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() =>
            pushToast({ title: "Paused", body: "Campaign pause/resume ships in Wave 5." })
          }
        >
          Pause
        </Button>
      </div>
    </div>
  );
}

function CampaignsTab({
  crmName,
  pushToast,
}: {
  crmName: string;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        {MOCK_CAMPAIGNS.map((c) => (
          <CampaignCard key={c.id} campaign={c} pushToast={pushToast} />
        ))}
      </div>

      {/* Empty-state callout */}
      <div className="rounded-md border border-border bg-muted/30 px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          Need a new lifecycle campaign? Your CRM teammate can draft it.
        </p>
        <button
          onClick={() =>
            pushToast({ title: "Briefing", body: "Campaign brief flow ships in Wave 5." })
          }
          className="shrink-0 text-[11px] text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium whitespace-nowrap"
        >
          Brief {crmName} →
        </button>
      </div>
    </div>
  );
}

// ─── Onboarding tab ───────────────────────────────────────────────────────────

function OnboardingTab({
  pushToast,
}: {
  pushToast: (input: { title: string; body: string }) => void;
}) {
  const stages = MOCK_FUNNEL;
  const maxCount = stages[0].count;

  return (
    <div className="space-y-6">
      {/* Funnel */}
      <div className="rounded-md border border-border bg-card divide-y divide-border overflow-hidden">
        {stages.map((stage, idx) => {
          const prevCount = idx > 0 ? stages[idx - 1].count : stage.count;
          const convPct = idx === 0 ? 100 : Math.round((stage.count / prevCount) * 100);
          const barWidth = Math.round((stage.count / maxCount) * 100);
          const isDropOff = idx === 2; // First action drop

          return (
            <div
              key={stage.label}
              className={cn(
                "px-4 py-3 flex items-center gap-3",
                isDropOff && "bg-amber-500/5",
              )}
            >
              <div className="w-24 shrink-0">
                <p
                  className={cn(
                    "text-[10px] uppercase tracking-[0.12em] font-medium",
                    isDropOff ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                  )}
                >
                  {stage.label}
                </p>
              </div>
              <div className="flex-1">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      isDropOff
                        ? "bg-amber-500"
                        : "bg-[var(--brand,theme(colors.teal.500))]",
                    )}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
              <div className="w-12 text-right tabular-nums text-xs font-semibold text-foreground shrink-0">
                {stage.count.toLocaleString()}
              </div>
              {idx > 0 && (
                <div
                  className={cn(
                    "w-10 text-right tabular-nums text-[11px] font-medium shrink-0",
                    convPct < 30 ? "text-amber-500" : convPct < 60 ? "text-foreground/60" : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {convPct}%
                </div>
              )}
              {idx === 0 && <div className="w-10 shrink-0" />}
            </div>
          );
        })}
      </div>

      {/* Drop-off alert */}
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 flex items-start justify-between gap-4">
        <p className="text-sm text-foreground/80 leading-relaxed">
          <span className="font-semibold text-foreground">
            Biggest drop-off: Email verified → First action (40% loss).
          </span>{" "}
          Nudge experiment in backlog.
        </p>
        <button
          onClick={() =>
            pushToast({ title: "Added to backlog", body: "Nudge experiment added to idea queue." })
          }
          className="shrink-0 text-[11px] text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium whitespace-nowrap"
        >
          + Add to backlog
        </button>
      </div>

      {/* Activation over time (CSS-only bar chart) */}
      <div className="rounded-md border border-border bg-card p-4 space-y-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
          Activation over time · 14 days
        </p>
        <div className="flex items-end gap-1 h-16">
          {MOCK_ACTIVATION_BARS.map((h, i) => {
            const maxH = Math.max(...MOCK_ACTIVATION_BARS);
            const pct = Math.round((h / maxH) * 100);
            return (
              <div
                key={i}
                className="flex-1 rounded-sm bg-[var(--brand,theme(colors.teal.500))]/30 hover:bg-[var(--brand,theme(colors.teal.500))]/60 transition-colors"
                style={{ height: `${pct}%` }}
                title={`Day ${i + 1}: ${h} activations`}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between text-[9px] tabular-nums text-muted-foreground/50">
          <span>Apr 6</span>
          <span>Apr 19</span>
        </div>
      </div>
    </div>
  );
}

// ─── Churn tab ────────────────────────────────────────────────────────────────

function ChurnTab({
  crmName,
  pushToast,
}: {
  crmName: string;
  pushToast: (input: { title: string; body: string }) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Signal widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* At-risk */}
        <div className="rounded-md border border-red-500/30 bg-card p-4 flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500 shrink-0" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              At-risk accounts
            </p>
          </div>
          <p className="tabular-nums text-[32px] font-bold text-foreground leading-none">6</p>
          <p className="text-[11px] text-muted-foreground">No login in 14+ days</p>
        </div>
        {/* Usage dropped */}
        <div className="rounded-md border border-amber-500/30 bg-card p-4 flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shrink-0" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Usage dropped &gt;50%
            </p>
          </div>
          <p className="tabular-nums text-[32px] font-bold text-foreground leading-none">3</p>
          <p className="text-[11px] text-muted-foreground">vs. last 7 days</p>
        </div>
        {/* Cancellation hints */}
        <div className="rounded-md border border-red-500/30 bg-card p-4 flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500 shrink-0" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Cancellation hints
            </p>
          </div>
          <p className="tabular-nums text-[32px] font-bold text-foreground leading-none">1</p>
          <p className="text-[11px] text-muted-foreground">Detected in comments</p>
        </div>
      </div>

      {/* CTA */}
      <div className="rounded-md border border-border bg-muted/30 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          Your CRM teammate can draft a rescue sequence for all 6 — Brief {crmName} →
        </p>
        <button
          onClick={() =>
            pushToast({ title: "Briefing", body: "Rescue sequence brief flow ships in Wave 5." })
          }
          className="shrink-0 text-[11px] text-[var(--brand,theme(colors.teal.500))] hover:underline font-medium whitespace-nowrap"
        >
          Brief {crmName} →
        </button>
      </div>

      {/* At-risk list */}
      <div className="rounded-md border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Account
                </th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Risk signal
                </th>
                <th className="text-right px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
                  Days at risk
                </th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hidden sm:table-cell">
                  Assigned
                </th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {MOCK_AT_RISK.map((account) => (
                <tr key={account.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-[12px] font-semibold text-foreground">{account.company}</p>
                    <p className="tabular-nums text-[10px] text-muted-foreground">
                      {formatK(account.acv)} ARR
                    </p>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground max-w-[200px]">
                    <span className="line-clamp-2">{account.signal}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[12px] font-semibold text-red-500">
                    {account.daysAtRisk}d
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground hidden sm:table-cell">
                    {account.assignee}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() =>
                        pushToast({
                          title: "Outreach drafted",
                          body: "Rescue outreach drafting ships in Wave 5.",
                        })
                      }
                    >
                      Reach out
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CrmConsole({ companyId: _companyId, agents }: {
  companyId: string | null;
  agents: Agent[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToast();

  const rawTab = searchParams.get("tab");
  const activeTab: CrmTab = isValidTab(rawTab) ? rawTab : "pipeline";

  function setTab(tab: CrmTab) {
    setSearchParams({ tab });
  }

  // MOCK — Wave 5 replaces with real CRM service.
  // Resolve CRM teammate display name from agents prop.
  // CRM doesn't have a canonical role; fall back to pm or literal "Orbit".
  const crmAgent = agents.find((a) => a.role === "pm") ?? agents[0];
  const crmName = crmAgent?.name ?? "Orbit";
  const teammateCount = agents.length || 1;

  // Inject resolved name into deal owner fields
  const resolvedDeals: Deal[] = MOCK_DEALS.map((d) => ({
    ...d,
    owner: crmName,
  }));

  const atRiskResolved: AtRiskAccount[] = MOCK_AT_RISK.map((a) => ({
    ...a,
    assignee: crmName,
  }));
  void atRiskResolved; // used inside ChurnTab via MOCK_AT_RISK directly; kept for reference

  const pipelineCount = resolvedDeals.length;
  const weightedPipeline = columnSum(resolvedDeals);
  const activeCampaigns = MOCK_CAMPAIGNS.filter((c) => c.status === "active").length;

  const displayH1 =
    pipelineCount === 0
      ? "Quiet pipeline"
      : `${pipelineCount} account${pipelineCount === 1 ? "" : "s"} in pipeline`;

  const tabItems = [
    { value: "pipeline", label: "Pipeline" },
    { value: "campaigns", label: `Campaigns · ${MOCK_CAMPAIGNS.length}` },
    { value: "onboarding", label: "Onboarding" },
    { value: "churn", label: "Churn" },
  ];

  return (
    <div className="space-y-6">
      {/* Editorial page header */}
      <header className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          CRM &amp; Lifecycle
        </div>
        <h1 className="font-display text-[32px] md:text-[40px] leading-[1.05] tracking-tight text-foreground">
          {displayH1}
        </h1>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{teammateCount}</span>{" "}
          {teammateCount === 1 ? "teammate" : "teammates"}
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">{formatK(weightedPipeline)}</span> weighted pipeline
          <span className="mx-2 text-muted-foreground/40">·</span>
          <span className="font-medium text-foreground">{activeCampaigns}</span> active campaigns
        </p>
      </header>

      {/* Tab bar */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as CrmTab)}>
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(v) => setTab(v as CrmTab)}
          align="start"
        />
      </Tabs>

      {/* Tab content */}
      <div>
        {activeTab === "pipeline" && (
          <PipelineTab deals={resolvedDeals} crmName={crmName} pushToast={pushToast} />
        )}
        {activeTab === "campaigns" && (
          <CampaignsTab crmName={crmName} pushToast={pushToast} />
        )}
        {activeTab === "onboarding" && <OnboardingTab pushToast={pushToast} />}
        {activeTab === "churn" && <ChurnTab crmName={crmName} pushToast={pushToast} />}
      </div>
    </div>
  );
}
