import { Link } from "@/lib/router";
import { ArrowRight, Wallet } from "lucide-react";

export interface CapitalAllocationCardProps {
  /**
   * Recommendations land in S3.8 (channel-recommendation engine) once
   * integrations sync (S2). Until then this card is a placeholder
   * pointing the founder at the dependency chain.
   */
  hasIntegrationsConnected?: boolean;
}

/**
 * Capital Allocation — the 4th Chief-of-Staff dashboard module per the
 * DoubtBuddy PRD. Surfaces "which growth channels deserve more budget /
 * which product lines to pause / ROI ranking."
 *
 * S1: placeholder pointing at the dependency chain.
 * S2: data flows in via PostHog + Stripe + LinkedIn ingestion.
 * S3.8: channel-recommender writes insights here.
 * S5.6: LTV/CAC per channel rolls in from Finance.
 */
export function CapitalAllocationCard({
  hasIntegrationsConnected = false,
}: CapitalAllocationCardProps = {}) {
  return (
    <section
      aria-label="Capital Allocation"
      className="rounded-md border border-border bg-card px-5 py-4"
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <p className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Capital Allocation
          </p>
        </div>
        <Link
          to="/integrations"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground no-underline"
        >
          {hasIntegrationsConnected ? "Manage integrations" : "Connect integrations"}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {hasIntegrationsConnected ? (
        <p className="text-sm text-muted-foreground">
          Channel ROI ranking and budget reallocation insights will surface here as your
          Chief of Staff sees enough data to call them with confidence.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect Stripe, PostHog, and LinkedIn to surface budget reallocation insights.
          Your Chief of Staff will rank channels by ROI and flag where to double down.
        </p>
      )}
    </section>
  );
}
