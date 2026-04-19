import { Link } from "@/lib/router";
import { ArrowRight, BarChart3, Briefcase, Building2, CheckCircle2, PenLine, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FounderOSLogo } from "@/components/FounderOSLogo";

/**
 * Public marketing landing page. The first surface anyone hits when they
 * visit the product unauthenticated. Designed to sell the AI-native-CEO
 * value prop in one screen + two scrolls.
 *
 * Editorial Notion/Coda register: serif display headlines, restrained
 * accent, generous whitespace, no gradient bloat, no stock shadcn card
 * shadow flood. Copy is business-first ("a company staffed by AI").
 */
export function Landing() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TopBar />
      <main className="flex-1">
        <Hero />
        <HowItWorks />
        <FeatureGrid />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-6 md:px-10 h-14 flex items-center justify-between">
        <FounderOSLogo size={20} />
        <nav className="flex items-center gap-2">
          <Link to="/auth" className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5">
            Sign in
          </Link>
          <Link to="/auth">
            <Button size="sm" className="gap-1.5">
              Get started <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="border-b border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-28">
        <div className="grid grid-cols-1 md:grid-cols-[1.1fr,1fr] gap-12 md:gap-20 items-start">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-8">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
              The AI company OS for solo founders
            </div>
            <h1 className="font-display text-[52px] md:text-[76px] leading-[0.98] tracking-tight text-foreground">
              Run a company
              <br />
              <span className="relative inline-block">
                <span className="font-display-italic text-[var(--brand)] relative z-[1]">staffed by AI.</span>
                <span
                  aria-hidden
                  className="absolute left-0 right-0 bottom-[6px] h-[10px] md:h-[14px] rounded-full"
                  style={{
                    background: "color-mix(in oklch, var(--brand) 18%, transparent)",
                    zIndex: 0,
                  }}
                />
              </span>
            </h1>
            <p className="mt-8 max-w-xl text-[17px] md:text-[18px] text-foreground/80 leading-[1.6]">
              A CEO, a CTO, a head of growth, an ops lead — twenty AI teammates reporting
              into a real org chart, working on real goals, on the providers you already
              pay for. Live in under five minutes.
            </p>
            <div className="mt-10 flex items-center gap-4 flex-wrap">
              <Link to="/auth">
                <Button size="lg" className="gap-2">
                  Build your company
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <span className="text-[13px] text-muted-foreground">
                Free to start · Bring your own Claude, Codex, or Gemini key
              </span>
            </div>
            <div className="mt-16 grid grid-cols-3 gap-6 max-w-md">
              <Stat label="Providers" value="3" sub="Claude · Codex · Gemini" />
              <Stat label="Setup" value="<5m" sub="Template → launch" />
              <Stat label="Tenancy" value="Single" sub="One isolated instance" />
            </div>
          </div>

          {/* Right column — a structured "morning brief" preview. Serves as
              the product's own screenshot without dropping an actual PNG. */}
          <BriefPreview />
        </div>
      </div>
    </section>
  );
}

function BriefPreview() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 md:p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
        Morning brief · Thursday
      </div>
      <h3 className="font-display text-[32px] leading-[1.05] tracking-tight text-foreground">
        Good morning, Alex.
      </h3>
      <p className="mt-3 text-[14px] text-foreground/80 leading-[1.6]">
        Acme Labs ran 14 work sessions and shipped 3 things in the last 12 hours.
        Spend this month: $340 (12% of cap).
      </p>

      <div className="grid grid-cols-2 gap-5 mt-6">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-2">
            Needs your call
          </div>
          <ul className="space-y-2 text-[12px]">
            <li className="flex items-start gap-2">
              <span className="mt-[5px] inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              <div>
                <div className="font-medium text-foreground">2 approvals pending</div>
                <div className="text-muted-foreground">Review and sign off</div>
              </div>
            </li>
          </ul>
        </div>
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-2">
            Your team shipped
          </div>
          <ul className="space-y-2 text-[12px]">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
              <span className="text-foreground font-medium truncate">Q4 pricing page draft</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
              <span className="text-foreground font-medium truncate">Outreach sent to 14 prospects</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-border/70 flex items-center justify-between gap-3">
        <div className="text-[11px] text-muted-foreground">
          Set today&apos;s focus.
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          <PenLine className="h-3 w-3" />
          Brief the team
        </span>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps: Array<{ n: string; label: string; sub: string }> = [
    {
      n: "01",
      label: "Pick a starting team",
      sub: "Three prebuilt org shapes or import a team exported from another company.",
    },
    {
      n: "02",
      label: "Connect an AI provider",
      sub: "Use your Claude Code subscription, OpenAI Codex CLI, Gemini CLI, or an API key.",
    },
    {
      n: "03",
      label: "Launch and brief the team",
      sub: "Your CEO, CTO, and direct reports go live. Write one line to set the week's focus.",
    },
  ];
  return (
    <section className="border-b border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="max-w-2xl mb-12">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
            How it works
          </div>
          <h2 className="font-display text-[36px] md:text-[48px] leading-[1.05] tracking-tight text-foreground">
            Three steps from zero to a running company.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
          {steps.map((s) => (
            <div key={s.n} className="border-l border-border pl-6">
              <div className="text-[11px] font-medium tabular-nums text-muted-foreground mb-2">
                {s.n}
              </div>
              <h3 className="font-display text-[22px] leading-[1.15] tracking-tight text-foreground mb-2">
                {s.label}
              </h3>
              <p className="text-[13px] text-muted-foreground leading-[1.6]">{s.sub}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureGrid() {
  const features: Array<{
    icon: typeof Briefcase;
    label: string;
    sub: string;
  }> = [
    {
      icon: Briefcase,
      label: "Real org chart",
      sub: "Every teammate has a title, a manager, standing instructions, and a monthly comp cap. It reads like a company, not a pool of agents.",
    },
    {
      icon: Building2,
      label: "Morning brief",
      sub: "What happened overnight, what needs your call, what shipped. The first 30 seconds of your day, answered.",
    },
    {
      icon: BarChart3,
      label: "Honest ROI",
      sub: "See who's earning their comp. Monthly spend next to issues closed. Runway chip next to the greeting. No dashboards to assemble.",
    },
    {
      icon: Shield,
      label: "Your keys, your infra",
      sub: "Single-tenant by default. AES-256-GCM encrypted key vault. Deploy on Fly.io in a single command or bring your own VPC.",
    },
  ];

  return (
    <section className="border-b border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="max-w-2xl mb-12">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
            What you get
          </div>
          <h2 className="font-display text-[36px] md:text-[48px] leading-[1.05] tracking-tight text-foreground">
            An operating system for your first million.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16">
          {features.map((f) => (
            <div key={f.label} className="flex items-start gap-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border">
                <f.icon className="h-4 w-4 text-foreground/80" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-semibold text-foreground tracking-tight mb-1.5">
                  {f.label}
                </h3>
                <p className="text-[13.5px] text-muted-foreground leading-[1.65]">{f.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section>
      <div className="mx-auto max-w-3xl px-6 md:px-10 py-24 md:py-32 text-center">
        <h2 className="font-display text-[44px] md:text-[60px] leading-[1.02] tracking-tight text-foreground">
          Start your company.
          <br />
          <span className="relative inline-block">
            <span className="font-display-italic text-[var(--brand)] relative z-[1]">Hire your team.</span>
            <span
              aria-hidden
              className="absolute left-0 right-0 bottom-[4px] h-[8px] md:h-[12px] rounded-full"
              style={{
                background: "color-mix(in oklch, var(--brand) 18%, transparent)",
                zIndex: 0,
              }}
            />
          </span>
        </h2>
        <p className="mt-6 mx-auto max-w-xl text-[15px] text-muted-foreground leading-[1.65]">
          Five minutes of setup and you&apos;re running a company of twenty AI teammates.
          Bring your own provider keys. Your data stays on your infra.
        </p>
        <div className="mt-10">
          <Link to="/auth">
            <Button size="lg" className="gap-2">
              Build your company <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-8 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <FounderOSLogo size={18} />
          <span className="text-[12px] text-muted-foreground">
            © {new Date().getFullYear()} FounderOS
          </span>
        </div>
        <div className="flex items-center gap-5 text-[12px] text-muted-foreground">
          <a href="/legal/terms" className="hover:text-foreground">Terms</a>
          <a href="/legal/privacy" className="hover:text-foreground">Privacy</a>
          <a href="https://github.com/founderos-ai/founderos" target="_blank" rel="noreferrer" className="hover:text-foreground">GitHub</a>
        </div>
      </div>
    </footer>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
        {label}
      </div>
      <div className="font-display text-[28px] leading-none tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground leading-snug">{sub}</div>
    </div>
  );
}
