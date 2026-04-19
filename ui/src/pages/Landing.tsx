import { Link } from "@/lib/router";
import {
  ArrowRight,
  BarChart3,
  Briefcase,
  Building2,
  CheckCircle2,
  Clock,
  DollarSign,
  MessageCircle,
  PenLine,
  Shield,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FounderOSLogo } from "@/components/FounderOSLogo";

/**
 * Public marketing landing page.
 *
 * Aesthetic: editorial Notion/Coda register with pulse-style data beats
 * — serif display headlines, restrained accent, tight section rhythm,
 * and a dark "night" panel breaking the middle so the page has a
 * heartbeat rather than scrolling as one flat surface.
 *
 * Copy register: a founder talking to a founder. Specific, confident,
 * outcome-first, never feature-listy.
 */
export function Landing() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TopBar />
      <main className="flex-1">
        <Hero />
        <PulseStrip />
        <MeetTheTeam />
        <ForYouAgainstOldWay />
        <HowItWorks />
        <FeatureGrid />
        <BuiltForCta />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Top nav
// ─────────────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-6 md:px-10 h-14 flex items-center justify-between">
        <FounderOSLogo size={20} />
        <nav className="flex items-center gap-2">
          <Link
            to="/auth"
            className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
          >
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

// ─────────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="border-b border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-28">
        <div className="grid grid-cols-1 md:grid-cols-[1.1fr,1fr] gap-12 md:gap-20 items-start">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-8">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]" />
              </span>
              Live — the AI company OS
            </div>
            <h1 className="font-display text-[52px] md:text-[76px] leading-[0.98] tracking-tight text-foreground">
              Run a million-dollar
              <br />
              company as a
              <br />
              <span className="relative inline-block">
                <span className="font-display-italic text-[var(--brand)] relative z-[1]">
                  party of one.
                </span>
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
              FounderOS ships you a complete AI team — CEO, CTO, head of growth,
              ops lead, and a dozen direct reports — with an org chart, shift
              schedule, monthly comp caps, and a Morning Brief that tells you
              what happened while you slept.
            </p>
            <div className="mt-10 flex items-center gap-4 flex-wrap">
              <Link to="/auth">
                <Button size="lg" className="gap-2">
                  Build your company
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <span className="text-[13px] text-muted-foreground">
                Free while you&apos;re under $10k MRR · BYO provider keys
              </span>
            </div>
            <div className="mt-14 grid grid-cols-3 gap-6 max-w-md">
              <Stat label="Setup" value="<5m" sub="Template → launch" />
              <Stat label="Team" value="20" sub="Across 3 providers" />
              <Stat label="Hosting" value="Single" sub="One tenant per founder" />
            </div>
          </div>

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
        Acme Labs ran 14 work sessions and shipped 3 things in the last 12
        hours. Spend this month: $340 (12% of cap).
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
              <span className="text-foreground font-medium truncate">
                Outreach sent to 14 prospects
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-border/70 flex items-center justify-between gap-3">
        <div className="text-[11px] text-muted-foreground">Set today&apos;s focus.</div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          <PenLine className="h-3 w-3" />
          Brief the team
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pulse strip — a sub-hero that shows the product's heartbeat numbers
// ─────────────────────────────────────────────────────────────────────────

function PulseStrip() {
  const beats: Array<{ value: string; label: string }> = [
    { value: "38", label: "Work sessions today" },
    { value: "14", label: "Issues closed this week" },
    { value: "$340", label: "Spent this month" },
    { value: "6 mo", label: "Runway at current pace" },
  ];
  return (
    <section className="border-b border-border/70 bg-[color:color-mix(in_oklch,var(--muted)_28%,var(--background))]">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-10 md:py-14">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
          {beats.map((b) => (
            <div key={b.label} className="flex flex-col gap-1">
              <div className="font-display text-[36px] md:text-[44px] leading-none tabular-nums text-foreground">
                {b.value}
              </div>
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {b.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Meet the team — product's concrete "what you get day one"
// ─────────────────────────────────────────────────────────────────────────

function MeetTheTeam() {
  const roster: Array<{ name: string; title: string; comp: string; focus: string }> = [
    { name: "Nova", title: "Chief Executive Officer", comp: "$200/mo", focus: "Runs the week, writes the brief" },
    { name: "Atlas", title: "Chief Technology Officer", comp: "$250/mo", focus: "Ships code, reviews PRs" },
    { name: "Orbit", title: "Head of Growth", comp: "$200/mo", focus: "Runs outbound, tracks pipeline" },
    { name: "Ledger", title: "Head of Finance & Ops", comp: "$150/mo", focus: "Burn, runway, vendor contracts" },
  ];
  return (
    <section className="border-b border-border/70">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="max-w-2xl mb-14">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
            Meet the team
          </div>
          <h2 className="font-display text-[36px] md:text-[48px] leading-[1.05] tracking-tight text-foreground">
            Your first four hires, ready on day one.
          </h2>
          <p className="mt-4 text-[14px] text-muted-foreground leading-[1.65]">
            Every template ships a complete starter roster. Comp caps are real.
            Each teammate knows who they report to and what they&apos;re supposed
            to ship.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {roster.map((r) => (
            <div
              key={r.name}
              className="rounded-lg border border-border bg-card p-5 hover:border-foreground/25 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-foreground">
                  {r.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold text-foreground tracking-tight truncate">
                    {r.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">{r.title}</div>
                </div>
              </div>
              <div className="mt-4 text-[13px] text-foreground/80 leading-snug">{r.focus}</div>
              <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> On call
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <DollarSign className="h-3 w-3" />
                  {r.comp}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// You vs the old way — hiring comparison table
// ─────────────────────────────────────────────────────────────────────────

function ForYouAgainstOldWay() {
  const rows: Array<{ item: string; old: string; newWay: string }> = [
    { item: "Time to a working team", old: "6 months of hiring", newWay: "5 minutes from a template" },
    { item: "Monthly burn", old: "$80k+ in comp", newWay: "$500 in provider spend" },
    { item: "Management overhead", old: "1:1s, reviews, offsites", newWay: "Morning brief · one line" },
    { item: "Scaling a new function", old: "Recruit, interview, onboard", newWay: "Hire a teammate · 30 seconds" },
    { item: "Who's accountable", old: "Trust, over time", newWay: "Reports-to graph from day one" },
  ];
  return (
    <section className="border-b border-border/70 bg-[color:color-mix(in_oklch,var(--muted)_12%,var(--background))]">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="max-w-2xl mb-10">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3">
            The shift
          </div>
          <h2 className="font-display text-[36px] md:text-[48px] leading-[1.05] tracking-tight text-foreground">
            You, against the old way of building a company.
          </h2>
        </div>
        <div className="rounded-lg border border-border bg-background overflow-hidden">
          <div className="grid grid-cols-[1.25fr,1fr,1fr] text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <div className="px-5 py-3 border-b border-r border-border">What</div>
            <div className="px-5 py-3 border-b border-r border-border">Classic startup</div>
            <div className="px-5 py-3 border-b border-border">With FounderOS</div>
          </div>
          {rows.map((r, i) => (
            <div
              key={r.item}
              className={`grid grid-cols-[1.25fr,1fr,1fr] text-[13.5px] ${
                i < rows.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <div className="px-5 py-4 font-medium text-foreground border-r border-border">
                {r.item}
              </div>
              <div className="px-5 py-4 text-muted-foreground line-through decoration-muted-foreground/40 border-r border-border">
                {r.old}
              </div>
              <div className="px-5 py-4 text-foreground font-medium">{r.newWay}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// How it works
// ─────────────────────────────────────────────────────────────────────────

function HowItWorks() {
  const steps: Array<{ n: string; label: string; sub: string }> = [
    {
      n: "01",
      label: "Pick a starting team",
      sub: "Three prebuilt org shapes — Pre-seed AI Lab, Solo Indie SaaS, Bootstrapped B2B — or import a roster exported from another company.",
    },
    {
      n: "02",
      label: "Connect an AI provider",
      sub: "Log in with your Claude Code subscription, OpenAI Codex CLI, or Gemini CLI. Or paste an API key. FounderOS detects what's available and routes automatically.",
    },
    {
      n: "03",
      label: "Launch and brief the team",
      sub: "The team goes live. Write one line in the Morning Brief to set the week's focus — the CEO fans it out to reports on the next shift.",
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
              <p className="text-[13px] text-muted-foreground leading-[1.65]">{s.sub}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Feature grid
// ─────────────────────────────────────────────────────────────────────────

function FeatureGrid() {
  const features: Array<{ icon: typeof Briefcase; label: string; sub: string }> = [
    {
      icon: Briefcase,
      label: "A real org chart",
      sub: "Every teammate has a title, a manager, standing instructions, a shift schedule, and a monthly comp cap. It reads like a company, not a pool of agents.",
    },
    {
      icon: Sparkles,
      label: "Morning Brief",
      sub: "What happened overnight, who's blocked, what shipped, today's focus, and your runway — all above the fold, every morning.",
    },
    {
      icon: BarChart3,
      label: "Honest ROI",
      sub: "Each roster card shows spend this month next to issues closed this month. See who's earning their comp without opening a spreadsheet.",
    },
    {
      icon: MessageCircle,
      label: "Brief the team",
      sub: "Write one line — \"Focus the week on Acme onboarding\" — and it flows down the org chart to every relevant teammate on their next shift.",
    },
    {
      icon: Building2,
      label: "Import / export",
      sub: "Companies travel. Export any running company as a template, replay it into a fresh instance, or clone your own org for a new experiment.",
    },
    {
      icon: Shield,
      label: "Your keys, your infra",
      sub: "Single-tenant by default. AES-256-GCM encrypted key vault. Deploy on Fly.io in one command or bring your own VPC.",
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10 md:gap-12">
          {features.map((f) => (
            <div key={f.label}>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border mb-4">
                <f.icon className="h-4 w-4 text-foreground/80" />
              </div>
              <h3 className="text-[15px] font-semibold text-foreground tracking-tight mb-1.5">
                {f.label}
              </h3>
              <p className="text-[13.5px] text-muted-foreground leading-[1.65]">{f.sub}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Built for — audience quotes / framing
// ─────────────────────────────────────────────────────────────────────────

function BuiltForCta() {
  return (
    <section className="border-b border-border/70 bg-foreground text-background">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr] gap-12 md:gap-20 items-start">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-background/70 mb-3">
              Built for
            </div>
            <h2 className="font-display text-[36px] md:text-[48px] leading-[1.05] tracking-tight text-background">
              Solo operators who
              <br />
              refuse to hire six people.
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 md:gap-8">
            {[
              { title: "Technical founders", sub: "Ship product without a team. Your CTO teammate handles PRs while you talk to customers." },
              { title: "Indie builders", sub: "Keep $80k/year out of burn. Your Head of Growth teammate runs outbound at $200/month." },
              { title: "Pre-seed CEOs", sub: "Stretch your first $250k. Pilot GTM, content, and ops with AI before hiring humans." },
              { title: "Bootstrappers", sub: "Stay profitable. Your team scales with provider spend, not salaries." },
            ].map((x) => (
              <div key={x.title}>
                <div className="text-[14px] font-semibold text-background mb-1">
                  {x.title}
                </div>
                <p className="text-[12.5px] text-background/75 leading-[1.65]">{x.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Final CTA
// ─────────────────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section>
      <div className="mx-auto max-w-3xl px-6 md:px-10 py-24 md:py-32 text-center">
        <h2 className="font-display text-[44px] md:text-[60px] leading-[1.02] tracking-tight text-foreground">
          Start your company.
          <br />
          <span className="relative inline-block">
            <span className="font-display-italic text-[var(--brand)] relative z-[1]">
              Hire your team.
            </span>
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
          Five minutes of setup and you&apos;re running a team of twenty AI
          teammates. Bring your own provider keys. Your data stays on your
          infra.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4 flex-wrap">
          <Link to="/auth">
            <Button size="lg" className="gap-2">
              Build your company <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <span className="text-[12.5px] text-muted-foreground">Free while you&apos;re under $10k MRR</span>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────────

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
          <a href="/legal/terms" className="hover:text-foreground">
            Terms
          </a>
          <a href="/legal/privacy" className="hover:text-foreground">
            Privacy
          </a>
          <a
            href="https://github.com/founderos-ai/founderos"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────

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
