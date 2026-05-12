import { Link } from "@/lib/router";
import { useEffect, useState } from "react";
import { FounderOSLogo } from "@/components/FounderOSLogo";

/**
 * Full SaaS marketing landing page.
 *
 * Visual system: Pulse Builders register — near-black editorial void,
 * bone off-white foreground, warm signal-orange accent used sparingly,
 * Fraunces display serif pushed sharp, JetBrains Mono for every data
 * row. Horizontal rules between sections, no card-shadow bloat,
 * editorial index numbering (001 → 012).
 *
 * Scope: the whole design system is inlined at the page root so it
 * never leaks into the authenticated app, which keeps its own Inter +
 * Instrument Serif + teal set.
 */
export function Landing() {
  // The authenticated app sets body { overflow: hidden; height: 100% }
  // to anchor its single-viewport layout. The landing needs normal page
  // scroll, so flip the body overflow on mount and restore on unmount.
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const prev = {
      bodyOverflow: body.style.overflow,
      bodyHeight: body.style.height,
      htmlOverflow: html.style.overflow,
      htmlHeight: html.style.height,
      title: document.title,
    };
    body.style.overflow = "auto";
    body.style.height = "auto";
    html.style.overflow = "auto";
    html.style.height = "auto";
    document.title = "FounderOS — Run your company with AI";
    return () => {
      body.style.overflow = prev.bodyOverflow;
      body.style.height = prev.bodyHeight;
      html.style.overflow = prev.htmlOverflow;
      html.style.height = prev.htmlHeight;
      document.title = prev.title;
    };
  }, []);

  return (
    <div className="pulse-root min-h-screen font-pulse bg-pulse-void text-pulse-bone antialiased">
      <style>{PULSE_SCOPED_CSS}</style>
      <TopBar />
      <main>
        <Hero />
        <BackedByStrip />
        <MorningBriefShowcase />
        <RosterShowcase />
        <ProvidersShowcase />
        <Services />
        <MetricStrip />
        <UseCases />
        <ShiftSection />
        <Testimonials />
        <Process />
        <Security />
        <Pricing />
        <FaqSection />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Scoped design tokens + typography — lives only inside the landing route.
// ─────────────────────────────────────────────────────────────────────────

const PULSE_SCOPED_CSS = `
/* The authenticated app sets body { overflow: hidden } for its own
   fixed-viewport layout. The landing is a full-scroll marketing page,
   so override at the root and give the page its own scroll context. */
html:has(.pulse-root), body:has(.pulse-root) {
  overflow: auto !important;
  height: auto !important;
}
.pulse-root {
  --pulse-void: #0a0a0c;
  --pulse-void-2: #0f1012;
  --pulse-elev: #17181b;
  --pulse-line: #1e2024;
  --pulse-line-hi: #2c2f35;
  --pulse-bone: #f2efe5;
  --pulse-bone-2: #cdc9bb;
  --pulse-muted: #807c72;
  --pulse-dim: #52504a;
  --pulse-accent: #ff5b29;
  color-scheme: dark;
  min-height: 100vh;
}
.pulse-root .bg-pulse-void { background: var(--pulse-void); }
.pulse-root .bg-pulse-elev { background: var(--pulse-void-2); }
.pulse-root .bg-pulse-elev-2 { background: var(--pulse-elev); }
.pulse-root .text-pulse-bone { color: var(--pulse-bone); }
.pulse-root .text-pulse-muted { color: var(--pulse-muted); }
.pulse-root .text-pulse-accent { color: var(--pulse-accent); }
.pulse-root .border-pulse-line { border-color: var(--pulse-line); }
.pulse-root .border-pulse-line-hi { border-color: var(--pulse-line-hi); }
.pulse-root .font-pulse {
  font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
  font-feature-settings: "ss01", "ss02", "cv11";
}
.pulse-root .font-display {
  font-family: "Fraunces", "Times New Roman", Georgia, serif;
  font-weight: 400;
  font-variation-settings: "SOFT" 0, "opsz" 144, "WONK" 0;
  letter-spacing: -0.035em;
  line-height: 0.94;
}
.pulse-root .font-display-italic {
  font-family: "Fraunces", "Times New Roman", Georgia, serif;
  font-style: italic;
  font-weight: 400;
  font-variation-settings: "SOFT" 50, "opsz" 144;
  letter-spacing: -0.03em;
}
.pulse-root .font-mono {
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  letter-spacing: 0;
}
.pulse-root .caps-wide { text-transform: uppercase; letter-spacing: 0.18em; }
.pulse-root .caps { text-transform: uppercase; letter-spacing: 0.12em; }
.pulse-root ::selection { background: var(--pulse-accent); color: var(--pulse-void); }

.pulse-root .led {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--pulse-accent);
  box-shadow: 0 0 14px var(--pulse-accent);
  position: relative;
  display: inline-block;
}
.pulse-root .led::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 999px;
  background: var(--pulse-accent);
  opacity: 0.35;
  animation: pulse-ring 1.6s ease-out infinite;
}
@keyframes pulse-ring {
  0% { transform: scale(0.8); opacity: 0.4; }
  100% { transform: scale(2.2); opacity: 0; }
}

.pulse-root .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.125rem;
  border: 1px solid var(--pulse-bone);
  background: var(--pulse-bone);
  color: var(--pulse-void);
  font-weight: 500;
  font-size: 13px;
  letter-spacing: 0.01em;
  transition: all 0.18s ease;
}
.pulse-root .btn:hover {
  background: var(--pulse-accent);
  border-color: var(--pulse-accent);
  color: var(--pulse-void);
}
.pulse-root .btn-ghost {
  background: transparent;
  border-color: var(--pulse-line-hi);
  color: var(--pulse-bone);
}
.pulse-root .btn-ghost:hover {
  border-color: var(--pulse-accent);
  color: var(--pulse-accent);
  background: transparent;
}
.pulse-root .hairline-grid > * + * { border-top: 1px solid var(--pulse-line); }
@media (min-width: 768px) {
  .pulse-root .hairline-grid-md > * + * { border-left: 1px solid var(--pulse-line); border-top: 0; }
}
`;

// ─────────────────────────────────────────────────────────────────────────
// Top nav
// ─────────────────────────────────────────────────────────────────────────

function TopBar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navLinks = [
    { to: "#product", label: "Product" },
    { to: "#how", label: "How it works" },
    { to: "#pricing", label: "Pricing" },
    { to: "#faq", label: "FAQ" },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-pulse-line backdrop-blur bg-[rgba(10,10,12,0.85)]">
      <div className="mx-auto max-w-6xl px-6 md:px-10 h-14 flex items-center justify-between">
        <FounderOSLogo size={18} />
        <nav className="hidden md:flex items-center gap-6 font-mono caps text-[10px] text-pulse-muted">
          {navLinks.map((l) => (
            <a key={l.to} href={l.to} className="hover:text-pulse-bone transition-colors">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden md:flex items-center gap-4 font-mono caps text-[10px]">
          <Link to="/auth" className="text-pulse-muted hover:text-pulse-bone transition-colors">
            Sign in
          </Link>
          <Link to="/auth" className="btn">
            Build your company <span aria-hidden>→</span>
          </Link>
        </div>
        <button
          className="md:hidden font-mono caps text-[10px] text-pulse-bone"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? "Close" : "Menu"}
        </button>
      </div>
      {mobileOpen && (
        <div className="md:hidden border-t border-pulse-line px-6 py-6 flex flex-col gap-5 font-mono caps text-[11px]">
          {navLinks.map((l) => (
            <a key={l.to} href={l.to} onClick={() => setMobileOpen(false)} className="text-pulse-bone">
              {l.label}
            </a>
          ))}
          <div className="flex flex-col gap-3 pt-2 border-t border-pulse-line">
            <Link to="/auth" className="text-pulse-bone">Sign in</Link>
            <Link to="/auth" className="btn" style={{ justifyContent: "center" }}>
              Build your company <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative min-h-[92svh] flex flex-col justify-between pt-28 md:pt-32 pb-12">
      <div className="mx-auto max-w-6xl px-4 md:px-10 w-full flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono caps-wide text-[10px] text-pulse-accent">EARLY ACCESS</span>
          <span className="font-mono caps text-[11px] text-pulse-muted">
            18 founders live · Est 2026
          </span>
        </div>
        <div className="font-mono caps text-[11px] text-pulse-muted flex items-center gap-2 flex-wrap md:max-w-[320px] md:text-right">
          <span className="led mr-1 align-middle" />
          Live — 18 founders running companies this week
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 md:px-10 w-full mt-16 md:mt-0">
        <h1 className="font-display" style={{ fontSize: "clamp(3rem, 1.8rem + 8vw, 10.5rem)" }}>
          <span>Build a $10M</span>
          <br />
          <span>company with</span>{" "}
          <span
            className="font-display-italic text-pulse-accent"
            style={{ background: "rgba(255,91,41,0.15)", padding: "0 0.12em" }}
          >
            3 people.
          </span>
        </h1>

        <p
          className="mt-8 max-w-[58ch] text-pulse-bone/75"
          style={{ fontSize: "clamp(1rem, 0.95rem + 0.4vw, 1.2rem)", lineHeight: 1.5 }}
        >
          FounderOS gives you an AI executive team in one workspace — growth,
          content, lifecycle CRM, finance, ops — so you can run a real company
          without building a real team. Measurable revenue growth in 14 to 30 days.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link to="/auth" className="btn">
            Design partner pricing · talk to us first <span aria-hidden>→</span>
          </Link>
          <a href="#product" className="btn btn-ghost">
            See the product <span aria-hidden>↓</span>
          </a>
        </div>
      </div>

      <ThisWeekPulse />
    </section>
  );
}

function ThisWeekPulse() {
  return (
    <div className="mx-auto max-w-6xl px-4 md:px-10 w-full mt-16 md:mt-0">
      <div className="grid grid-cols-12 gap-6 border-t border-pulse-line pt-6">
        <div className="col-span-12 md:col-span-3">
          <div className="flex items-center gap-2.5">
            <span className="led" />
            <span className="font-mono caps-wide text-[10px] text-pulse-accent">
              This week · Apr 19
            </span>
          </div>
          <div className="font-mono caps text-[10px] text-pulse-muted mt-2">
            Built for SaaS founders at $5k–$100k MRR
          </div>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">Teams building now</div>
          <ul className="space-y-0.5 font-mono text-[13px]">
            <li>agnost.ai <span className="text-pulse-muted">· pre-seed</span></li>
            <li>Pred <span className="text-pulse-muted">· seed</span></li>
            <li>Gravton Labs <span className="text-pulse-muted">· bootstrap</span></li>
          </ul>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">Last company shipped</div>
          <div className="font-mono text-[13px]">Solo Indie SaaS</div>
          <div className="font-mono text-[12px] text-pulse-muted">CEO + 6 direct reports · 5m setup</div>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">Open slots this quarter</div>
          <div className="font-mono text-[13px]">Unlimited</div>
          <div className="font-mono text-[12px] text-pulse-muted">Self-serve · always open</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Backed by / social proof
// ─────────────────────────────────────────────────────────────────────────

function BackedByStrip() {
  const logos = ["Anthropic", "OpenAI", "Google", "Fly.io", "Supabase", "Clerk"];
  return (
    <section className="border-y border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-10">
        <div className="grid grid-cols-12 gap-6 items-center">
          <div className="col-span-12 md:col-span-3">
            <div className="font-mono caps-wide text-[10px] text-pulse-muted">
              Built on the providers you already pay for
            </div>
          </div>
          <div className="col-span-12 md:col-span-9">
            <div className="flex flex-wrap items-center justify-between gap-6">
              {logos.map((l) => (
                <span
                  key={l}
                  className="font-display-italic text-pulse-bone/50 hover:text-pulse-bone transition-colors"
                  style={{ fontSize: "clamp(1.25rem, 1rem + 0.6vw, 1.5rem)" }}
                >
                  {l}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Product showcase 1 — Morning Brief
// ─────────────────────────────────────────────────────────────────────────

function MorningBriefShowcase() {
  return (
    <section id="product" className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-16 items-start">
        <div className="col-span-12 md:col-span-5 md:sticky md:top-24">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-4">
            002 — MORNING BRIEF
          </div>
          <h2 className="font-display" style={{ fontSize: "clamp(2.5rem, 1.5rem + 3vw, 4rem)" }}>
            The <span className="font-display-italic">first 30 seconds</span> of your day.
          </h2>
          <p className="mt-6 text-[15px] text-pulse-bone/75 leading-[1.65] max-w-[52ch]">
            Open your laptop. Read one page. Know what your company did while
            you were asleep, what&apos;s stuck, what&apos;s already shipped, and
            what to say yes to today. Your CEO teammate writes it. You read it
            with coffee.
          </p>
          <ul className="mt-8 space-y-3 font-mono text-[13px]">
            <li className="flex gap-3">
              <span className="text-pulse-accent">—</span>
              <span>Last night in one paragraph</span>
            </li>
            <li className="flex gap-3">
              <span className="text-pulse-accent">—</span>
              <span>Decisions only you can make, ranked</span>
            </li>
            <li className="flex gap-3">
              <span className="text-pulse-accent">—</span>
              <span>Today&apos;s one priority, picked for you</span>
            </li>
            <li className="flex gap-3">
              <span className="text-pulse-accent">—</span>
              <span>Brief the team in one line</span>
            </li>
          </ul>
        </div>
        <div className="col-span-12 md:col-span-7">
          <BriefMockup />
        </div>
      </div>
    </section>
  );
}

function BriefMockup() {
  return (
    <div className="rounded-sm border border-pulse-line bg-pulse-void p-7 md:p-8">
      <div className="flex items-center gap-2 mb-4">
        <span className="led" />
        <span className="font-mono caps-wide text-[10px] text-pulse-accent">
          Morning brief · Thursday
        </span>
        <span className="ml-auto font-mono caps text-[10px] text-pulse-muted">6 mo runway</span>
      </div>
      <h3 className="font-display" style={{ fontSize: "clamp(1.75rem, 1.2rem + 1.4vw, 2.25rem)" }}>
        Good morning, Alex.
      </h3>
      <p className="mt-3 text-[13.5px] text-pulse-bone/75 leading-[1.6]">
        Acme Labs ran 14 work sessions and shipped 3 things in the last 12
        hours. Spend this month: $340 (12% of cap).
      </p>

      <div className="mt-6 p-4 border border-pulse-line rounded-sm">
        <div className="font-mono caps text-[10px] text-pulse-muted mb-1">Today&apos;s focus</div>
        <div className="text-[14px] font-medium">Finalize pricing page for Acme onboarding call · Friday 3pm</div>
      </div>

      <div className="grid grid-cols-2 gap-5 mt-5">
        <div>
          <div className="font-mono caps text-[10px] text-pulse-muted mb-3">Needs your call</div>
          <ul className="space-y-3 text-[12.5px]">
            <li className="flex items-start gap-2">
              <span className="mt-[5px] inline-block h-1.5 w-1.5 rounded-full bg-[color:#f59e0b]" />
              <span>2 approvals pending</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-[5px] inline-block h-1.5 w-1.5 rounded-full bg-pulse-accent" />
              <span>Atlas blocked on API keys</span>
            </li>
          </ul>
        </div>
        <div>
          <div className="font-mono caps text-[10px] text-pulse-muted mb-3">Your team shipped</div>
          <ul className="space-y-3 text-[12.5px]">
            <li className="flex items-start gap-2">
              <span className="mt-[5px] inline-block h-1.5 w-1.5 rounded-full bg-[color:#10b981]" />
              <span>Q4 pricing draft</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-[5px] inline-block h-1.5 w-1.5 rounded-full bg-[color:#10b981]" />
              <span>14 outbound emails</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-pulse-line flex items-center justify-between">
        <span className="font-mono caps text-[10px] text-pulse-muted">Set today&apos;s focus</span>
        <span className="font-mono caps text-[10px] text-pulse-bone border border-pulse-line-hi px-2.5 py-1.5">
          Brief the team →
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Product showcase 2 — Team Roster
// ─────────────────────────────────────────────────────────────────────────

function RosterShowcase() {
  return (
    <section className="border-y border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-16 items-start">
          <div className="col-span-12 md:col-span-7 order-2 md:order-1">
            <RosterMockup />
          </div>
          <div className="col-span-12 md:col-span-5 order-1 md:order-2 md:sticky md:top-24">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-4">
              003 — TEAM
            </div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.5rem, 1.5rem + 3vw, 4rem)" }}>
              An org chart,
              <br />
              <span className="font-display-italic">not a pile of agents.</span>
            </h2>
            <p className="mt-6 text-[15px] text-pulse-bone/75 leading-[1.65] max-w-[52ch]">
              Your CTO reports to your CEO. Your head of growth sits next to
              them. Each teammate has a name, a title, a monthly cap, and a
              shift they show up for. You can see what they spent this month
              and what they closed. The math is right there on the card.
            </p>
            <ul className="mt-8 space-y-3 font-mono text-[13px]">
              <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Real reports-to structure</span></li>
              <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Per-teammate shift and on-call</span></li>
              <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Hard monthly comp caps</span></li>
              <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Spent vs. closed, no scrolling</span></li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function RosterMockup() {
  const cards = [
    { name: "Nova", role: "CEO", reports: "—", work: 3, comp: 200, spent: 142 },
    { name: "Atlas", role: "CTO", reports: "Nova", work: 5, comp: 250, spent: 189 },
    { name: "Orbit", role: "Head of Growth", reports: "Nova", work: 2, comp: 200, spent: 98 },
    { name: "Ledger", role: "Finance & Ops", reports: "Nova", work: 1, comp: 150, spent: 42 },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {cards.map((c) => {
        const pct = Math.min(100, Math.round((c.spent / c.comp) * 100));
        return (
          <div key={c.name} className="rounded-sm border border-pulse-line bg-pulse-void p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-pulse-line-hi font-mono text-[11px]">
                {c.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold tracking-tight">{c.name}</div>
                <div className="font-mono caps text-[10px] text-pulse-muted">{c.role}</div>
                <div className="font-mono text-[10.5px] text-pulse-muted mt-1">↳ {c.reports}</div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 font-mono caps text-[10px]">
              <span className="h-1.5 w-1.5 rounded-full bg-pulse-accent" />
              <span className="text-pulse-bone">Working</span>
              <span className="ml-auto text-pulse-muted">{c.work} open</span>
            </div>
            <div className="mt-4 pt-3 border-t border-pulse-line flex items-center justify-between font-mono text-[11px]">
              <span className="text-pulse-bone">✓ {c.work}</span>
              <span className="text-pulse-muted">${c.comp}/mo</span>
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-pulse-muted">
              <span>${c.spent} spent</span>
              <span>{pct}%</span>
            </div>
            <div className="mt-1 h-[2px] bg-pulse-line overflow-hidden">
              <div className="h-full bg-pulse-bone" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Product showcase 3 — Provider flexibility
// ─────────────────────────────────────────────────────────────────────────

function ProvidersShowcase() {
  return (
    <section className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-16 items-start">
        <div className="col-span-12 md:col-span-5 md:sticky md:top-24">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-4">
            004 — PROVIDERS
          </div>
          <h2 className="font-display" style={{ fontSize: "clamp(2.5rem, 1.5rem + 3vw, 4rem)" }}>
            Any model.
            <br />
            <span className="font-display-italic">Per teammate.</span>
          </h2>
          <p className="mt-6 text-[15px] text-pulse-bone/75 leading-[1.65] max-w-[52ch]">
            Put your CTO on Claude Opus. Keep your head of growth on Codex
            because that&apos;s what you already pay for. Run ops on Gemini
            Flash because it&apos;s cheap. Mix and match per teammate. If a
            provider is down, the next one picks up.
          </p>
          <ul className="mt-8 space-y-3 font-mono text-[13px]">
            <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Claude, Codex, Gemini — CLI or API</span></li>
            <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Subscription first, API when you must</span></li>
            <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Override any teammate any time</span></li>
            <li className="flex gap-3"><span className="text-pulse-accent">—</span><span>Gaps flagged before you launch</span></li>
          </ul>
        </div>
        <div className="col-span-12 md:col-span-7">
          <ProvidersMockup />
        </div>
      </div>
    </section>
  );
}

function ProvidersMockup() {
  const rows = [
    { name: "Anthropic Claude", state: "CLI installed · API key set", count: 4, color: "#d97757" },
    { name: "OpenAI Codex / GPT-5", state: "API key set", count: 2, color: "#10a37f" },
    { name: "Google Gemini", state: "CLI installed", count: 1, color: "#4285f4" },
  ];
  return (
    <div className="rounded-sm border border-pulse-line bg-pulse-void p-6 md:p-7">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-1">Providers</div>
          <div className="font-display" style={{ fontSize: "1.5rem" }}>Connected</div>
        </div>
        <span className="font-mono caps text-[10px] text-pulse-muted">3 of 3 ready</span>
      </div>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-4 p-4 border border-pulse-line rounded-sm">
            <span
              className="h-8 w-8 rounded-sm shrink-0"
              style={{ background: `color-mix(in oklch, ${r.color} 40%, var(--pulse-void))` }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-medium flex items-center gap-2">
                {r.name}
                <span className="font-mono caps text-[10px] bg-pulse-accent text-pulse-void px-1.5 py-0.5">
                  {r.count} teammate{r.count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="font-mono text-[11px] text-pulse-muted">{r.state}</div>
            </div>
            <span className="font-mono caps text-[10px] text-pulse-accent">Ready</span>
          </div>
        ))}
      </div>
      <div className="mt-6 pt-5 border-t border-pulse-line">
        <div className="font-mono caps text-[10px] text-pulse-muted mb-3">Routing strategy</div>
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <div className="p-2.5 border border-pulse-bone rounded-sm">
            <span className="text-pulse-bone">Mixed</span>
            <span className="text-pulse-muted"> · recommended</span>
          </div>
          <div className="p-2.5 border border-pulse-line rounded-sm text-pulse-muted">Claude first</div>
          <div className="p-2.5 border border-pulse-line rounded-sm text-pulse-muted">OpenAI first</div>
          <div className="p-2.5 border border-pulse-line rounded-sm text-pulse-muted">Gemini first</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Services — roles you're hiring
// ─────────────────────────────────────────────────────────────────────────

function Services() {
  const services = [
    { n: "01", label: "CEO / COS", sub: "Runs the week. Writes the brief. Chases down the people who aren't moving." },
    { n: "02", label: "Engineering", sub: "CTO plus engineers on Claude Code, Codex, or Cursor. Open PRs, review each other, ship features." },
    { n: "03", label: "Growth", sub: "Head of growth, content, outbound. Runs the experiments. Books the meetings." },
    { n: "04", label: "Finance & Ops", sub: "Watches runway. Handles vendors. Tells you when the burn is off." },
  ];

  return (
    <section className="border-t border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12">
          <div className="col-span-12 md:col-span-4">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">005 — ROLES</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              Every role a
              <br />
              <span className="font-display-italic">young company</span> needs.
            </h2>
          </div>
          <div className="col-span-12 md:col-span-8 md:col-start-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-10">
              {services.map((s) => (
                <div key={s.n}>
                  <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-2">{s.n}</div>
                  <h3 className="font-display mb-3" style={{ fontSize: "clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem)" }}>
                    {s.label}
                  </h3>
                  <p className="text-[14px] text-pulse-bone/70 leading-[1.55]">{s.sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Metric strip
// ─────────────────────────────────────────────────────────────────────────

function MetricStrip() {
  const beats = [
    { value: "<5m", label: "Zero to a running company" },
    { value: "20", label: "AI teammates per org" },
    { value: "3", label: "Providers · Claude, Codex, Gemini" },
    { value: "$299", label: "Starts at — Solo Founder tier" },
  ];
  return (
    <section className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12">
          {beats.map((b) => (
            <div key={b.label}>
              <div className="font-display" style={{ fontSize: "clamp(3rem, 2rem + 3vw, 4.5rem)" }}>
                {b.value}
              </div>
              <div className="font-mono caps-wide text-[10px] text-pulse-muted mt-3">{b.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Use cases
// ─────────────────────────────────────────────────────────────────────────

function UseCases() {
  const cases = [
    {
      tag: "Technical founder",
      outcome: "Ship product. Keep your inbox clear.",
      body: "Your CTO teammate pushes PRs while you're on a call. Your designer sits in Figma Dev Mode. You stay on the customer side of the table.",
    },
    {
      tag: "Indie operator",
      outcome: "Keep $80k out of your burn.",
      body: "Head of growth runs outbound on $200/month. Ops lead closes the books on $150. The team costs less than one junior hire.",
    },
    {
      tag: "Pre-seed CEO",
      outcome: "Stretch the first $250k.",
      body: "Pilot GTM, content, and ops with an AI team first. Learn what works. Hire humans only for the parts that keep hurting.",
    },
    {
      tag: "Bootstrapper",
      outcome: "Stay profitable on purpose.",
      body: "Your team scales on provider spend, not salaries. Double revenue without doubling headcount. Keep the kitchen-table math simple.",
    },
  ];
  return (
    <section className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-5">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">006 — BUILT FOR</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              For operators who
              <br />
              <span className="font-display-italic">refuse to wait.</span>
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 border-t border-pulse-line">
          {cases.map((c, i) => (
            <div
              key={c.tag}
              className={`p-7 border-pulse-line ${i < cases.length - 1 ? "border-b" : ""} ${i % 2 === 0 ? "md:border-r" : ""} ${i < 2 ? "md:border-b" : ""}`}
            >
              <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-4">{c.tag}</div>
              <h3 className="font-display mb-4" style={{ fontSize: "clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem)" }}>
                {c.outcome}
              </h3>
              <p className="text-[13.5px] text-pulse-bone/70 leading-[1.6] max-w-[52ch]">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shift — old vs new
// ─────────────────────────────────────────────────────────────────────────

function ShiftSection() {
  const rows = [
    { item: "Time to a working team", old: "6 months of hiring", next: "5 minutes from a template" },
    { item: "Monthly burn", old: "$80k+ in comp", next: "$500 in provider spend" },
    { item: "Scaling a function", old: "Recruit · interview · onboard", next: "Hire a teammate · 30s" },
    { item: "Management overhead", old: "1:1s · reviews · offsites", next: "Morning brief · one line" },
    { item: "Who's accountable", old: "Trust, over time", next: "Reports-to graph, day one" },
  ];
  return (
    <section className="border-t border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-5">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">007 — THE SHIFT</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              You, against the
              <br />
              <span className="font-display-italic">old way</span> of building.
            </h2>
          </div>
        </div>
        <div className="border border-pulse-line overflow-x-auto">
          <div className="md:min-w-[480px] min-w-full">
            <div className="grid md:grid-cols-[1.2fr,1fr,1fr] grid-cols-2 font-mono caps-wide text-[9px] md:text-[10px] text-pulse-muted">
              <div className="px-2 md:px-4 py-2 md:py-3 border-b md:border-r border-pulse-line">What</div>
              <div className="hidden md:block px-4 py-3 border-b border-r border-pulse-line">Classic startup</div>
              <div className="px-2 md:px-4 py-2 md:py-3 border-b border-pulse-line text-pulse-accent">With FounderOS</div>
            </div>
            {rows.map((r, i) => (
              <div key={r.item} className={`grid md:grid-cols-[1.2fr,1fr,1fr] grid-cols-2 text-[12px] md:text-[13px] ${i < rows.length - 1 ? "border-b border-pulse-line" : ""}`}>
                <div className="px-2 md:px-4 py-3 md:py-4 font-medium md:border-r border-pulse-line">{r.item}</div>
                <div className="hidden md:block px-4 py-4 text-pulse-muted line-through decoration-pulse-muted/60 border-r border-pulse-line">{r.old}</div>
                <div className="px-2 md:px-4 py-3 md:py-4 text-pulse-bone">{r.next}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Testimonials
// ─────────────────────────────────────────────────────────────────────────

function Testimonials() {
  const quotes = [
    {
      q: "Used to have five browser tabs of agent chats. Now I read one page with coffee and know where my company is. My Sunday review went from two hours to ten minutes.",
      name: "Reid M.",
      title: "Founder · Solo SaaS · $20k MRR",
    },
    {
      q: "The Morning Brief is the best UX decision in any AI product this year. It&rsquo;s the thing I actually wanted but didn&rsquo;t know how to ask for.",
      name: "Priya K.",
      title: "Pre-seed · AI research tooling",
    },
    {
      q: "My burn is down 70%. My ship velocity is up. Seeing spend-vs-closed on each teammate finally answered the question &lsquo;is this hire pulling their weight.&rsquo;",
      name: "Dmitri V.",
      title: "Bootstrapped · B2B workflow",
    },
  ];
  return (
    <section className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-6">008 — FOUNDERS</div>
        <h2 className="font-display mb-12" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
          What people
          <br />
          <span className="font-display-italic">actually say.</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 border-t border-pulse-line">
          {quotes.map((q, i) => (
            <div
              key={q.name}
              className={`p-7 border-pulse-line ${i < quotes.length - 1 ? "md:border-r border-b md:border-b-0" : ""}`}
            >
              <blockquote
                className="font-display text-pulse-bone mb-6"
                style={{ fontSize: "clamp(1.125rem, 1rem + 0.4vw, 1.25rem)", lineHeight: 1.4 }}
                dangerouslySetInnerHTML={{ __html: `&ldquo;${q.q}&rdquo;` }}
              />
              <div className="font-mono caps text-[10px] text-pulse-bone">{q.name}</div>
              <div className="font-mono caps text-[10px] text-pulse-muted mt-1">{q.title}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Process
// ─────────────────────────────────────────────────────────────────────────

function Process() {
  const steps = [
    { n: "01", label: "Pick a starting team", sub: "Three starter org shapes ship with the product. Or upload a roster a friend exported for you." },
    { n: "02", label: "Connect a provider", sub: "Log in with the Claude Code, Codex, or Gemini CLI you already pay for. Paste an API key if you prefer." },
    { n: "03", label: "Launch and brief", sub: "The team goes live. You write one line — &ldquo;let&rsquo;s focus on Acme onboarding this week&rdquo; — and the CEO takes it from there." },
  ];
  return (
    <section id="how" className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-4">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">009 — PROCESS</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              Three steps.
              <br />
              <span className="font-display-italic">Zero to live.</span>
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 border-t border-pulse-line">
          {steps.map((s, i) => (
            <div key={s.n} className={`p-7 border-pulse-line border-b ${i < steps.length - 1 ? "md:border-r" : ""} md:border-b-0`}>
              <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-6">{s.n}</div>
              <h3 className="font-display mb-4" style={{ fontSize: "clamp(1.625rem, 1.2rem + 1vw, 2rem)" }}>
                {s.label}
              </h3>
              <p className="text-[13.5px] text-pulse-bone/70 leading-[1.6]">{s.sub}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Security / trust
// ─────────────────────────────────────────────────────────────────────────

function Security() {
  const items = [
    { label: "One tenant, one founder", sub: "Your company gets its own Fly machine and its own Postgres. Nobody else is on it." },
    { label: "Keys stay encrypted", sub: "AES-256-GCM envelope encryption on every provider key. Nothing comes back raw, not even to you." },
    { label: "Bring your own infra", sub: "Deploy on Fly.io in one command. Or point at your own VPC and your own Postgres." },
    { label: "MIT engine", sub: "The core is open source. Fork it. Audit it. Run it on a Raspberry Pi if you want to." },
  ];
  return (
    <section className="border-t border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-5">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">010 — TRUST</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              Your company
              <br />
              <span className="font-display-italic">stays yours.</span>
            </h2>
            <p className="mt-6 text-[14px] text-pulse-bone/70 leading-[1.65] max-w-[52ch]">
              Single-tenant. Encrypted keys. MIT-licensed engine. Runs anywhere
              Docker runs. Your team, your data, your provider keys. Never
              pooled. Never shared. Never sold.
            </p>
          </div>
          <div className="col-span-12 md:col-span-7">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              {items.map((x) => (
                <div key={x.label}>
                  <div className="font-display mb-2" style={{ fontSize: "1.25rem" }}>{x.label}</div>
                  <p className="text-[13px] text-pulse-bone/70 leading-[1.6]">{x.sub}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────

function Pricing() {
  return (
    <section id="pricing" className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-5">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">011 — PRICING</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              Built for your
              <br />
              <span className="font-display-italic">stage of company.</span>
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 border-t border-pulse-line">
          {/* Tier 1 — Solo Founder */}
          <div className="p-6 md:p-10 border-b md:border-r md:border-b-0 border-pulse-line">
            <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-4">Solo Founder</div>
            <div className="font-display mb-1" style={{ fontSize: "clamp(2.5rem, 1.8rem + 2vw, 3.5rem)" }}>
              $299
            </div>
            <div className="font-mono text-[11px] text-pulse-muted mb-6">/ month · up to $799 with add-ons</div>
            <p className="text-[14px] text-pulse-bone/75 leading-[1.55] mb-6">
              For indie founders and creators running their first real company.
              One workspace, five departments, 20 workflows, 50k agent actions
              per month. Use your own provider keys.
            </p>
            <ul className="space-y-2 text-[13px] font-mono">
              <li>— 5 departments (CoS, Growth, Content, CRM, Finance Lite)</li>
              <li>— 20 workflows</li>
              <li>— 1 workspace, 1 seat</li>
              <li>— 50,000 agent tasks per month — a Daily Brief uses ~30, an inbox approval uses ~3</li>
              <li>— Use your own provider keys</li>
            </ul>
            <div className="mt-8">
              <Link to="/auth" className="btn w-full justify-center md:w-auto md:justify-start">
                Design partner pricing · talk to us first <span aria-hidden>→</span>
              </Link>
            </div>
          </div>

          {/* Tier 2 — Lean Team */}
          <div className="p-6 md:p-10 border-b md:border-r md:border-b-0 border-pulse-line bg-pulse-elev">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-4">Lean Team</div>
            <div className="font-display mb-1" style={{ fontSize: "clamp(2.5rem, 1.8rem + 2vw, 3.5rem)" }}>
              $2,000
            </div>
            <div className="font-mono text-[11px] text-pulse-muted mb-6">/ month · up to $5k at scale</div>
            <p className="text-[14px] text-pulse-bone/75 leading-[1.55] mb-6">
              For startups with 2–10 people. All departments, team collaboration,
              approvals, custom workflows, and real revenue forecasting. Designed
              to replace your first 6 hires.
            </p>
            <ul className="space-y-2 text-[13px] font-mono">
              <li>— All departments incl. Sales + Support</li>
              <li>— Team collaboration + approval workflows</li>
              <li>— Custom workflows + SOPs</li>
              <li>— Finance + revenue forecasting</li>
              <li>— Unlimited workflows</li>
              <li>— Shared company memory</li>
            </ul>
            <div className="mt-8">
              <a href="mailto:hello@founderos.ai" className="btn w-full justify-center md:w-auto md:justify-start">
                Design partner pricing · talk to us first <span aria-hidden>→</span>
              </a>
            </div>
          </div>

          {/* Tier 3 — Venture Studio */}
          <div className="p-6 md:p-10">
            <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-4">Venture Studio</div>
            <div className="font-display mb-1" style={{ fontSize: "clamp(2.5rem, 1.8rem + 2vw, 3.5rem)" }}>
              $10,000
            </div>
            <div className="font-mono text-[11px] text-pulse-muted mb-6">/ month · up to $50k+ with portfolio size</div>
            <p className="text-[14px] text-pulse-bone/75 leading-[1.55] mb-6">
              For portfolios, holdings, and venture studios operating multiple
              companies. Cross-company benchmarks, capital allocation AI,
              treasury layer, and shared growth memory across the portfolio.
            </p>
            <ul className="space-y-2 text-[13px] font-mono">
              <li>— Multi-company workspaces</li>
              <li>— Cross-company benchmarks + PMF scoring</li>
              <li>— Capital allocation AI + treasury layer</li>
              <li>— Portfolio reporting</li>
              <li>— Shared growth memory across companies</li>
              <li>— Dedicated success + priority provider access</li>
            </ul>
            <div className="mt-8">
              <a href="mailto:hello@founderos.ai" className="btn btn-ghost w-full justify-center md:w-auto md:justify-start">
                Design partner pricing · talk to us first <span aria-hidden>→</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// FAQ
// ─────────────────────────────────────────────────────────────────────────

function FaqSection() {
  const items = [
    {
      q: "Do I need to know how to code?",
      a: "No. Pick a template. Paste a provider key. Write a one-line brief when you feel like giving direction. Your CEO teammate figures out the rest — what to delegate, who's stuck, what to escalate back to you.",
    },
    {
      q: "What does it really cost to run?",
      a: "Three tiers. Solo Founder starts at $299/mo for indie builders. Lean Team at $2k/mo covers startups with 2–10 people. Venture Studio at $10k+ is for portfolios running multiple companies at once. Every tier uses your own provider keys — the spend you already make on Claude/Codex/Gemini doesn't change.",
    },
    {
      q: "Can I take my company with me?",
      a: "Coming soon — we're shipping company export in our next release. If you need this now, email us at hello@founderos.dev and we'll generate it manually.",
    },
    {
      q: "How private is my data?",
      a: "Single-tenant by default. Keys encrypted at rest, never returned raw. Deploy on Fly.io in one command or point at your own VPC. We never see your provider keys.",
    },
    {
      q: "What happens when a teammate gets stuck?",
      a: "They land on the Morning Brief under &ldquo;Needs your call.&rdquo; You unblock them with one message and the CEO teammate reroutes the rest of the team around the blocker.",
    },
    {
      q: "How is this different from just using Claude Code directly?",
      a: "Claude Code is one agent on your laptop. This is twenty teammates with titles, managers, shift schedules, comp caps, and a founder-facing brief on top. It's a company, not a console.",
    },
    {
      q: "Can I mix providers?",
      a: "Yes. CTO on Claude, head of growth on Codex, ops on Gemini Flash. Each teammate picks their preference. If one provider goes down, the next one picks up.",
    },
    {
      q: "What if I hire real humans later?",
      a: "The org chart is real. Swap a teammate for a person, keep their standing instructions and context. Your human hires read the same Morning Brief your AI team reads.",
    },
    {
      q: "Do I own the code my team writes?",
      a: "Yes. It runs on your infra, with your keys, against your repos. Agents push to branches you control. No model training on your code. No telemetry unless you flip it on.",
    },
    {
      q: "Is there an API?",
      a: "Yes — REST for every resource, webhooks for events, and an SDK if you want to plug in your own adapters. Docs at docs.founderos.ai.",
    },
  ];
  return (
    <section id="faq" className="border-t border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12">
          <div className="col-span-12 md:col-span-4">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">012 — QUESTIONS</div>
            <h2 className="font-display" style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}>
              Asked,
              <br />
              <span className="font-display-italic">answered.</span>
            </h2>
          </div>
          <div className="col-span-12 md:col-span-8">
            <div className="divide-y divide-pulse-line border-t border-b border-pulse-line">
              {items.map((it) => (
                <details key={it.q} className="group">
                  <summary className="flex items-start justify-between gap-6 py-5 cursor-pointer list-none">
                    <h3 className="font-display flex-1" style={{ fontSize: "clamp(1.125rem, 1rem + 0.4vw, 1.375rem)" }}>
                      {it.q}
                    </h3>
                    <span className="font-mono caps-wide text-[10px] text-pulse-muted mt-1 shrink-0 group-open:text-pulse-accent">
                      +
                    </span>
                  </summary>
                  <p className="pb-6 max-w-[62ch] text-[14px] text-pulse-bone/75 leading-[1.65]">
                    {it.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Contact
// ─────────────────────────────────────────────────────────────────────────

function Contact() {
  return (
    <section id="contact" className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-28 md:py-40">
        <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-6">013 — GO</div>
        <h2 className="font-display" style={{ fontSize: "clamp(3rem, 1.6rem + 6vw, 8.5rem)" }}>
          Start your company.
          <br />
          <span className="font-display-italic text-pulse-accent">Hire your team.</span>
        </h2>
        <p className="mt-8 max-w-[56ch] text-[15px] text-pulse-bone/70 leading-[1.55]">
          Bring a Claude, Codex, or Gemini key. Spend five minutes on setup.
          Walk in a solo operator. Walk out running a company.
        </p>
        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link to="/auth" className="btn">
            Build your company <span aria-hidden>→</span>
          </Link>
          <a href="mailto:hello@founderos.ai" className="btn btn-ghost">
            Say hello <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Footer — sitemap
// ─────────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-pulse-line bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-16">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 md:col-span-4">
            <FounderOSLogo size={20} />
            <p className="mt-5 max-w-xs text-[13px] text-pulse-bone/70 leading-[1.55]">
              The AI company OS for solo founders. Build a company. Hire your
              team. Run it from a single Morning Brief.
            </p>
            <div className="mt-8 font-mono caps text-[10px] text-pulse-muted">
              Made in India
            </div>
          </div>
          <FooterCol
            title="Product"
            items={[
              { label: "Morning Brief", href: "#product" },
              { label: "Team roster", href: "#product" },
              { label: "Providers", href: "#product" },
              { label: "Pricing", href: "#pricing" },
              { label: "Changelog", href: "#" },
            ]}
          />
          <FooterCol
            title="Company"
            items={[
              { label: "About", href: "#" },
              { label: "Careers", href: "#" },
              { label: "Blog", href: "#" },
              { label: "Press", href: "#" },
              { label: "Contact", href: "mailto:hello@founderos.ai" },
            ]}
          />
          <FooterCol
            title="Resources"
            items={[
              { label: "Docs", href: "https://docs.founderos.ai" },
              { label: "API reference", href: "https://docs.founderos.ai/api" },
              { label: "Templates", href: "#" },
              { label: "Community", href: "#" },
              { label: "GitHub", href: "https://github.com/founderos-ai/founderos" },
            ]}
          />
          <FooterCol
            title="For"
            items={[
              { label: "SaaS founders", href: "#" },
              { label: "Indie builders", href: "#" },
              { label: "Venture studios", href: "#" },
              { label: "Agencies", href: "#" },
            ]}
          />
        </div>

        <div className="mt-16 pt-8 border-t border-pulse-line flex items-center justify-between gap-4 flex-wrap font-mono text-[11px] text-pulse-muted">
          <div>© {new Date().getFullYear()} FounderOS. All rights reserved.</div>
          <div className="flex items-center gap-5">
            <a href="/legal/terms" className="hover:text-pulse-bone">Terms</a>
            <a href="/legal/privacy" className="hover:text-pulse-bone">Privacy</a>
            <a href="#" className="hover:text-pulse-bone">Status</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, items }: { title: string; items: Array<{ label: string; href: string }> }) {
  return (
    <div className="col-span-6 md:col-span-2 lg:col-span-2 md:col-start-auto">
      <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-4">{title}</div>
      <ul className="space-y-2.5 font-mono text-[12.5px]">
        {items.map((i) => (
          <li key={i.label}>
            <a
              href={i.href}
              target={i.href.startsWith("http") ? "_blank" : undefined}
              rel={i.href.startsWith("http") ? "noreferrer" : undefined}
              className="text-pulse-bone/80 hover:text-pulse-accent transition-colors"
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
