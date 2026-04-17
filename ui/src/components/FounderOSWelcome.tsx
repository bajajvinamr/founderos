import { Button } from "@/components/ui/button";
import { FounderOSLogo } from "@/components/FounderOSLogo";
import {
  Briefcase,
  Megaphone,
  PenLine,
  Wallet,
  ArrowRight,
  Sparkles,
} from "lucide-react";

type Department = {
  name: string;
  tagline: string;
  Icon: typeof Briefcase;
};

const DEPARTMENTS: Department[] = [
  { name: "Chief of Staff", tagline: "Runs the ops, clears your inbox, writes the board update.", Icon: Briefcase },
  { name: "Growth", tagline: "Finds channels, runs experiments, reports CAC weekly.", Icon: Megaphone },
  { name: "Content", tagline: "Ships a blog, newsletter, and social cadence on autopilot.", Icon: PenLine },
  { name: "Finance", tagline: "Watches MRR, burn, and runway. Flags anomalies daily.", Icon: Wallet },
];

interface FounderOSWelcomeProps {
  onStart: () => void;
}

/**
 * First-run welcome screen for a user with zero companies. Replaces the
 * generic empty state with a brand moment + template preview + single CTA.
 */
export function FounderOSWelcome({ onStart }: FounderOSWelcomeProps) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 md:py-20">
      {/* Hero */}
      <div className="relative rounded-2xl overflow-hidden border border-border">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklch, var(--brand) 18%, var(--background)) 0%, var(--background) 55%, color-mix(in oklch, var(--brand) 8%, var(--background)) 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.035] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
          }}
        />
        <div className="relative px-8 py-12 md:px-14 md:py-16">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[var(--brand)]">
            <Sparkles className="h-3.5 w-3.5" />
            Welcome to FounderOS
          </div>
          <h1 className="mt-4 text-3xl md:text-5xl font-semibold tracking-tight leading-[1.05] text-foreground max-w-2xl">
            Your company,<br />
            <span className="text-[var(--brand)]">alive in ten minutes.</span>
          </h1>
          <p className="mt-5 text-base md:text-lg text-muted-foreground leading-relaxed max-w-xl">
            Pick a department template, plug in your Anthropic key, and watch four AI agents start running ops, growth, content, and finance for you tonight.
          </p>
          <div className="mt-8 flex items-center gap-3">
            <Button size="lg" onClick={onStart} className="gap-2">
              Set up your company
              <ArrowRight className="h-4 w-4" />
            </Button>
            <a
              href="/docs/what-is-founderos"
              className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-[color:color-mix(in_oklch,var(--brand)_55%,transparent)]"
            >
              What is FounderOS?
            </a>
          </div>
        </div>
      </div>

      {/* Department grid */}
      <div className="mt-10">
        <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground mb-4">
          Departments you can spin up
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {DEPARTMENTS.map(({ name, tagline, Icon }) => (
            <div
              key={name}
              className="flex items-start gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-[color:color-mix(in_oklch,var(--brand)_45%,var(--border))]"
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                style={{
                  background: "color-mix(in oklch, var(--brand) 14%, transparent)",
                  color: "var(--brand)",
                }}
              >
                <Icon className="h-5 w-5" strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{name}</div>
                <div className="mt-1 text-sm text-muted-foreground leading-relaxed">{tagline}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer strip */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <FounderOSLogo size={14} markOnly />
          <span>FounderOS · MIT-licensed agent engine · BYO Anthropic key</span>
        </div>
        <div>Single-tenant. Your data, your infra.</div>
      </div>
    </div>
  );
}
