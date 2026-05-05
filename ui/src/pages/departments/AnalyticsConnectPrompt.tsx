/**
 * AnalyticsConnectPrompt — paid-tier empty state for the GrowthConsole.
 *
 * Council 2026-05-05 P2 (TC-2): on a paid plan, the GrowthConsole MUST NOT
 * render mock data. When the company has no analytics integration connected
 * yet, this prompt is shown instead — explaining what's missing and linking
 * to /integrations to wire it up.
 *
 * Three connectors are listed because all three are needed to populate the
 * S3 demo metrics ("32% of signups from LinkedIn" requires Stripe for paid
 * conversion, PostHog for funnel events, LinkedIn for source attribution).
 *
 * Sized to feel honest, not punitive. The page header above still renders
 * (so the founder still sees "Growth Department" + their teammates), this
 * fills only the tab content slot.
 */
import { ArrowRight, BarChart3, CreditCard, Linkedin, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";

interface AnalyticsConnectPromptProps {
  /** Tab name for analytics surface — informs the headline copy. */
  surface: "experiments" | "channels" | "funnel" | "paid";
}

const SURFACE_HEADLINE: Record<AnalyticsConnectPromptProps["surface"], string> = {
  experiments: "Connect analytics to ground experiments in real numbers",
  channels: "Connect analytics to see your real channel mix",
  funnel: "Connect analytics to see your real funnel",
  paid: "Connect analytics to track paid spend against signups",
};

const CONNECTORS = [
  {
    id: "stripe",
    name: "Stripe",
    icon: CreditCard,
    blurb: "Paid conversions, MRR, churn",
  },
  {
    id: "posthog",
    name: "PostHog",
    icon: BarChart3,
    blurb: "Pageviews, signups, activation",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: Linkedin,
    blurb: "Source attribution, channel mix",
  },
] as const;

export function AnalyticsConnectPrompt({ surface }: AnalyticsConnectPromptProps) {
  const navigate = useNavigate();

  return (
    <div
      data-testid="analytics-connect-prompt"
      className="rounded-md border border-dashed border-border bg-card px-6 py-10 sm:px-10 sm:py-12 flex flex-col items-center gap-6 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border">
        <LineChart className="h-5 w-5 text-muted-foreground/70" />
      </div>

      <div className="max-w-md flex flex-col gap-2">
        <h2 className="font-display text-[22px] leading-[1.2] tracking-tight text-foreground">
          {SURFACE_HEADLINE[surface]}
        </h2>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          We will not show you sample numbers on a paid plan. Connect at least
          one of these to start seeing your own data.
        </p>
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-lg">
        {CONNECTORS.map(({ id, name, icon: Icon, blurb }) => (
          <li
            key={id}
            className="rounded-md border border-border bg-background px-4 py-3 flex flex-col items-center gap-1.5 text-left sm:text-center"
          >
            <Icon className="h-4 w-4 text-foreground/70" aria-hidden />
            <p className="text-[13px] font-medium text-foreground">{name}</p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              {blurb}
            </p>
          </li>
        ))}
      </ul>

      <Button
        size="sm"
        className="gap-1.5"
        onClick={() => navigate("/integrations")}
      >
        Connect an analytics source
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
