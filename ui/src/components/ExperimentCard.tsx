import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Experiment, ExperimentStatus } from "../api/experiments";

// ─── Status styling — reuses GrowthConsole's pill aesthetic ─────────────────

const STATUS_PILL_CLASSES: Record<ExperimentStatus, string> = {
  proposed: "bg-muted text-muted-foreground border border-border",
  running: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border border-teal-500/30",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  abandoned: "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/30",
};

const STATUS_LABELS: Record<ExperimentStatus, string> = {
  proposed: "Proposed",
  running: "Running",
  completed: "Completed",
  abandoned: "Abandoned",
};

// Channel display labels — keeps the wire enum readable.
const CHANNEL_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  paid_meta: "Paid (Meta)",
  paid_google: "Paid (Google)",
  referral: "Referral",
  seo: "SEO",
  partnerships: "Partnerships",
  content: "Content",
};

function relativeTimeShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${Math.max(0, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCac(cents: string | null): string | null {
  if (!cents) return null;
  // Backend serialises bigint as string. Convert via Number — values past
  // 2^53 lose precision, but a CAC over $90 trillion in cents is not a real
  // operating concern.
  const dollars = Number(cents) / 100;
  if (Number.isNaN(dollars)) return null;
  if (Math.abs(dollars) >= 1000) return `$${Math.round(dollars).toLocaleString()}`;
  return `$${dollars.toFixed(2)}`;
}

function formatLift(pct: number | null): string | null {
  if (pct === null || pct === undefined) return null;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function IceScore({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.1em]">{label}</span>
      <span className="tabular-nums text-[13px] font-semibold text-foreground">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: ExperimentStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
        STATUS_PILL_CLASSES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// ─── Main card ───────────────────────────────────────────────────────────────

export interface ExperimentCardProps {
  experiment: Experiment;
  ownerName?: string | null;
}

export function ExperimentCard({ experiment, ownerName }: ExperimentCardProps) {
  const channelLabel = experiment.channel ? CHANNEL_LABELS[experiment.channel] ?? experiment.channel : null;
  const cacLabel = formatCac(experiment.expectedCacCents);
  const expectedLift = formatLift(experiment.expectedLiftPct);
  const actualLift = formatLift(experiment.actualLiftPct);
  const iceTotal = experiment.iceImpact * experiment.iceConfidence * experiment.iceEase;
  const iceScore = experiment.iceScore ?? iceTotal / 10;

  return (
    <Card className="rounded-md p-4 !py-4 !gap-3 hover:border-foreground/20 transition-colors shadow-none">
      {/* Header: hypothesis + status pill */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-foreground leading-snug flex-1">
          {experiment.hypothesis}
        </p>
        <StatusPill status={experiment.status} />
      </div>

      {/* Channel + owner */}
      {(channelLabel || ownerName) && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {channelLabel && (
            <Badge variant="outline" className="font-medium text-foreground/70">
              {channelLabel}
            </Badge>
          )}
          {channelLabel && ownerName && <span className="text-muted-foreground/40">·</span>}
          {ownerName && <span>{ownerName}</span>}
        </div>
      )}

      {/* ICE scores */}
      <div className="flex items-center gap-3">
        <IceScore label="I" value={experiment.iceImpact} />
        <IceScore label="C" value={experiment.iceConfidence} />
        <IceScore label="E" value={experiment.iceEase} />
        <div className="ml-auto flex flex-col items-center gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-[0.1em]">ICE</span>
          <span
            className={cn(
              "tabular-nums text-[15px] font-bold",
              iceScore >= 50 ? "text-[var(--brand,theme(colors.teal.500))]" : "text-foreground",
            )}
          >
            {iceScore.toFixed(iceScore % 1 === 0 ? 0 : 1)}
          </span>
        </div>
      </div>

      {/* Expected / actual lift + CAC */}
      {(expectedLift || actualLift || cacLabel) && (
        <div className="flex items-center gap-3 text-[11px] flex-wrap">
          {actualLift !== null ? (
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              Actual {actualLift}
            </span>
          ) : (
            expectedLift !== null && (
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                Expected {expectedLift}
              </span>
            )
          )}
          {cacLabel && (
            <>
              {(actualLift !== null || expectedLift !== null) && <span className="text-muted-foreground/40">·</span>}
              <span className="text-muted-foreground tabular-nums">{cacLabel} CAC</span>
            </>
          )}
        </div>
      )}

      {/* Next milestone */}
      {experiment.nextMilestone && (
        <p className="text-[11px] text-muted-foreground italic leading-snug">
          Next: {experiment.nextMilestone}
        </p>
      )}

      {/* Timestamp */}
      <div className="text-[10px] text-muted-foreground/60 tabular-nums">
        {experiment.completedAt
          ? `Completed ${relativeTimeShort(experiment.completedAt)}`
          : `Created ${relativeTimeShort(experiment.createdAt)}`}
      </div>
    </Card>
  );
}
