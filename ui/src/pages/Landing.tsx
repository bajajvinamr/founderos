import { Link } from "@/lib/router";
import { FounderOSLogo } from "@/components/FounderOSLogo";

/**
 * Public marketing landing page.
 *
 * Visual direction: Pulse Builders register. Near-black editorial void,
 * bone off-white foreground, warm signal-orange accent used sparingly,
 * Fraunces display serif pushed sharp, JetBrains Mono for every data row.
 * Horizontal rules separate sections. "INDEX 001" editorial numbering.
 *
 * Scope: the entire pulse-register design system is inlined at the page
 * root so it does NOT leak into the authenticated app (which stays on
 * the Instrument Serif + Inter set from index.css).
 */
export function Landing() {
  return (
    <div className="pulse-root min-h-screen font-pulse bg-pulse-void text-pulse-bone antialiased">
      <style>{PULSE_SCOPED_CSS}</style>
      <TopBar />
      <main>
        <Hero />
        <SectionRule />
        <Services />
        <SectionRule />
        <MetricStrip />
        <SectionRule />
        <MeetTheTeam />
        <SectionRule />
        <ShiftSection />
        <SectionRule />
        <Process />
        <SectionRule />
        <Pricing />
        <SectionRule />
        <FaqSection />
        <SectionRule />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Scoped design tokens + typography — lives only inside the landing route.
// Everything else in the app stays on its own fonts + tokens.
// ─────────────────────────────────────────────────────────────────────────

const PULSE_SCOPED_CSS = `
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
}
.pulse-root .bg-pulse-void { background: var(--pulse-void); }
.pulse-root .bg-pulse-elev { background: var(--pulse-void-2); }
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
`;

// ─────────────────────────────────────────────────────────────────────────
// Top nav — agency-style minimal
// ─────────────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-pulse-line backdrop-blur bg-[rgba(10,10,12,0.8)]">
      <div className="mx-auto max-w-6xl px-6 md:px-10 h-14 flex items-center justify-between">
        <FounderOSLogo size={18} />
        <nav className="flex items-center gap-4 font-mono caps text-[10px]">
          <Link to="/auth" className="text-pulse-muted hover:text-pulse-bone transition-colors">
            Sign in
          </Link>
          <Link to="/auth" className="btn">
            Build your company <span aria-hidden>→</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Hero — editorial, huge Fraunces display, with live "This week" pulse
// ─────────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative min-h-[92svh] flex flex-col justify-between pt-28 md:pt-32 pb-12">
      <div className="mx-auto max-w-6xl px-6 md:px-10 w-full flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono caps-wide text-[10px] text-pulse-accent">INDEX 001</span>
          <span className="font-mono caps text-[11px] text-pulse-muted">
            FounderOS · The AI company OS · Est 2026
          </span>
        </div>
        <div className="font-mono caps text-[11px] text-pulse-muted md:max-w-[320px] md:text-right">
          <span className="led inline-block mr-2 align-middle" />
          Live — 18 founders running companies this week
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 md:px-10 w-full mt-20 md:mt-0">
        <h1
          className="font-display"
          style={{ fontSize: "clamp(3.5rem, 1.8rem + 8vw, 10.5rem)" }}
        >
          <span>Run a</span>{" "}
          <span className="font-display-italic text-pulse-accent">million-dollar</span>
          <br />
          <span>company as a</span>{" "}
          <span className="font-display-italic text-pulse-accent">party of one.</span>
        </h1>

        <p
          className="mt-8 max-w-[58ch] text-pulse-bone/75"
          style={{ fontSize: "clamp(1rem, 0.95rem + 0.4vw, 1.2rem)", lineHeight: 1.5 }}
        >
          FounderOS ships you a complete AI team — CEO, CTO, head of growth, ops
          lead — with an org chart, shift schedule, monthly comp caps, and a
          Morning Brief that tells you what happened while you slept.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link to="/auth" className="btn">
            Start your company <span aria-hidden>→</span>
          </Link>
          <a href="#how" className="btn btn-ghost">
            How it works <span aria-hidden>↓</span>
          </a>
        </div>
      </div>

      {/* Live pulse module — the "This week" data strip */}
      <ThisWeekPulse />
    </section>
  );
}

function ThisWeekPulse() {
  return (
    <div className="mx-auto max-w-6xl px-6 md:px-10 w-full mt-20 md:mt-0">
      <div className="grid grid-cols-12 gap-6 border-t border-pulse-line pt-6">
        <div className="col-span-12 md:col-span-3">
          <div className="flex items-center gap-2.5">
            <span className="led" />
            <span className="font-mono caps-wide text-[10px] text-pulse-accent">
              This week · Apr 19
            </span>
          </div>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">
            Teams building now
          </div>
          <ul className="space-y-0.5 font-mono text-[13px]">
            <li>agnost.ai <span className="text-pulse-muted">· pre-seed</span></li>
            <li>Pred <span className="text-pulse-muted">· seed</span></li>
            <li>Gravton Labs <span className="text-pulse-muted">· bootstrap</span></li>
          </ul>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">
            Last company shipped
          </div>
          <div className="font-mono text-[13px]">Solo Indie SaaS</div>
          <div className="font-mono text-[12px] text-pulse-muted">
            CEO + 6 direct reports · 5m setup
          </div>
        </div>
        <div className="col-span-12 md:col-span-3">
          <div className="font-mono caps text-[10px] text-pulse-muted mb-1.5">
            Open slots this quarter
          </div>
          <div className="font-mono text-[13px]">Unlimited</div>
          <div className="font-mono text-[12px] text-pulse-muted">Self-serve · always open</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Services — what we hire for you
// ─────────────────────────────────────────────────────────────────────────

function Services() {
  const services: Array<{ n: string; label: string; sub: string }> = [
    {
      n: "01",
      label: "CEO / COS",
      sub: "Runs the week. Writes the brief. Unblocks direct reports. The first teammate to wake up every morning.",
    },
    {
      n: "02",
      label: "Engineering",
      sub: "CTO + engineers on Claude Code / Codex / Cursor. Open PRs, review each other's work, ship features.",
    },
    {
      n: "03",
      label: "Growth",
      sub: "Head of growth, content, outbound. Uses your data to run experiments and book meetings.",
    },
    {
      n: "04",
      label: "Finance & Ops",
      sub: "Runway tracking, vendor management, burn alerts, end-of-month books. The part you hate most — automated.",
    },
  ];

  return (
    <section id="services" className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-12">
        <div className="col-span-12 md:col-span-4">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">002 — ROLES</div>
          <h2
            className="font-display"
            style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
          >
            Every role a
            <br />
            <span className="font-display-italic">young company</span>{" "}
            needs.
          </h2>
        </div>
        <div className="col-span-12 md:col-span-8 md:col-start-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-10">
            {services.map((s) => (
              <div key={s.n}>
                <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-2">{s.n}</div>
                <h3
                  className="font-display mb-3"
                  style={{ fontSize: "clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem)" }}
                >
                  {s.label}
                </h3>
                <p className="text-[14px] text-pulse-bone/70 leading-[1.55]">{s.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Metric strip — the "pulse" as big editorial numbers
// ─────────────────────────────────────────────────────────────────────────

function MetricStrip() {
  const beats: Array<{ value: string; label: string }> = [
    { value: "<5m", label: "Zero to a running company" },
    { value: "20", label: "AI teammates per org" },
    { value: "3", label: "Providers · Claude, Codex, Gemini" },
    { value: "$0", label: "Until you're over $10k MRR" },
  ];
  return (
    <section className="bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-20 md:py-24">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-12">
          {beats.map((b) => (
            <div key={b.label}>
              <div
                className="font-display"
                style={{ fontSize: "clamp(3rem, 2rem + 3vw, 4.5rem)" }}
              >
                {b.value}
              </div>
              <div className="font-mono caps-wide text-[10px] text-pulse-muted mt-3">
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
// Meet the team — four sample teammates as mini-profiles
// ─────────────────────────────────────────────────────────────────────────

function MeetTheTeam() {
  const roster: Array<{ name: string; role: string; comp: string; ship: string }> = [
    { name: "Nova", role: "Chief Executive", comp: "$200/mo", ship: "Runs the week. Writes the brief." },
    { name: "Atlas", role: "Chief Technology", comp: "$250/mo", ship: "Ships PRs. Reviews code." },
    { name: "Orbit", role: "Head of Growth", comp: "$200/mo", ship: "Runs outbound. Tracks pipeline." },
    { name: "Ledger", role: "Finance & Ops", comp: "$150/mo", ship: "Watches burn. Closes books." },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-12 mb-16">
        <div className="col-span-12 md:col-span-4">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">003 — ROSTER</div>
          <h2
            className="font-display"
            style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
          >
            Meet your
            <br />
            <span className="font-display-italic">first four hires.</span>
          </h2>
        </div>
        <div className="col-span-12 md:col-span-7 md:col-start-6 flex items-end">
          <p className="text-[15px] text-pulse-bone/70 leading-[1.6] max-w-[52ch]">
            Every template ships a complete org. Each teammate has a title, a
            manager, standing instructions, and a monthly comp cap. Edit anything
            on day two.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-t border-pulse-line">
        {roster.map((r, i) => (
          <div
            key={r.name}
            className={`p-7 border-pulse-line ${i < roster.length - 1 ? "md:border-r" : ""} ${i < 2 ? "md:border-b lg:border-b-0" : ""} border-b md:last:border-b-0`}
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-pulse-line-hi font-mono text-[12px]">
                {r.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-mono caps text-[10px] text-pulse-muted">{r.role}</div>
              </div>
            </div>
            <h3
              className="font-display mb-5"
              style={{ fontSize: "clamp(1.625rem, 1.2rem + 1vw, 2rem)" }}
            >
              {r.name}
            </h3>
            <p className="text-[13.5px] text-pulse-bone/75 leading-[1.55] mb-5">{r.ship}</p>
            <div className="flex items-center justify-between pt-4 border-t border-pulse-line font-mono caps text-[10px]">
              <span className="text-pulse-muted">On call</span>
              <span className="text-pulse-bone">{r.comp}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The shift — old way vs FounderOS
// ─────────────────────────────────────────────────────────────────────────

function ShiftSection() {
  const rows: Array<{ item: string; old: string; next: string }> = [
    { item: "Time to a working team", old: "6 months of hiring", next: "5 minutes from a template" },
    { item: "Monthly burn", old: "$80k+ in comp", next: "$500 in provider spend" },
    { item: "Scaling a function", old: "Recruit · interview · onboard", next: "Hire a teammate · 30s" },
    { item: "Management overhead", old: "1:1s · reviews · offsites", next: "Morning brief · one line" },
    { item: "Who's accountable", old: "Trust, over time", next: "Reports-to graph, day one" },
  ];
  return (
    <section className="bg-pulse-elev">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
        <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
          <div className="col-span-12 md:col-span-5">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">004 — THE SHIFT</div>
            <h2
              className="font-display"
              style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
            >
              You, against the
              <br />
              <span className="font-display-italic">old way</span> of building.
            </h2>
          </div>
        </div>

        <div className="border border-pulse-line">
          <div className="grid grid-cols-[1.2fr,1fr,1fr] font-mono caps-wide text-[10px] text-pulse-muted">
            <div className="px-5 py-3 border-b border-r border-pulse-line">What</div>
            <div className="px-5 py-3 border-b border-r border-pulse-line">Classic startup</div>
            <div className="px-5 py-3 border-b border-pulse-line text-pulse-accent">With FounderOS</div>
          </div>
          {rows.map((r, i) => (
            <div
              key={r.item}
              className={`grid grid-cols-[1.2fr,1fr,1fr] text-[13.5px] ${
                i < rows.length - 1 ? "border-b border-pulse-line" : ""
              }`}
            >
              <div className="px-5 py-5 font-medium border-r border-pulse-line">{r.item}</div>
              <div className="px-5 py-5 text-pulse-muted line-through decoration-pulse-muted/60 border-r border-pulse-line">
                {r.old}
              </div>
              <div className="px-5 py-5 text-pulse-bone">{r.next}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Process — three steps
// ─────────────────────────────────────────────────────────────────────────

function Process() {
  const steps: Array<{ n: string; label: string; sub: string }> = [
    {
      n: "01",
      label: "Pick a starting team",
      sub: "Three prebuilt org shapes or import a roster exported from another company.",
    },
    {
      n: "02",
      label: "Connect a provider",
      sub: "Log in with your Claude Code subscription, Codex CLI, or Gemini CLI. Or paste an API key.",
    },
    {
      n: "03",
      label: "Launch and brief",
      sub: "The team goes live. Write one line to set the week's focus. The CEO fans it to reports.",
    },
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
        <div className="col-span-12 md:col-span-4">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">005 — PROCESS</div>
          <h2
            className="font-display"
            style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
          >
            Three steps.
            <br />
            <span className="font-display-italic">Zero to live.</span>
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 border-t border-pulse-line">
        {steps.map((s, i) => (
          <div
            key={s.n}
            className={`p-7 border-pulse-line border-b ${i < steps.length - 1 ? "md:border-r" : ""} md:border-b-0`}
          >
            <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-6">{s.n}</div>
            <h3
              className="font-display mb-4"
              style={{ fontSize: "clamp(1.625rem, 1.2rem + 1vw, 2rem)" }}
            >
              {s.label}
            </h3>
            <p className="text-[13.5px] text-pulse-bone/70 leading-[1.6]">{s.sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pricing — just two tiers, editorial
// ─────────────────────────────────────────────────────────────────────────

function Pricing() {
  return (
    <section className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-12 mb-14">
        <div className="col-span-12 md:col-span-5">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">006 — PRICING</div>
          <h2
            className="font-display"
            style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
          >
            Free until
            <br />
            <span className="font-display-italic">you&apos;re winning.</span>
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 border-t border-pulse-line">
        <div className="p-8 md:p-10 border-b md:border-r border-pulse-line">
          <div className="font-mono caps-wide text-[10px] text-pulse-muted mb-4">Solo</div>
          <div
            className="font-display mb-6"
            style={{ fontSize: "clamp(2.5rem, 1.8rem + 2vw, 3.5rem)" }}
          >
            $0<span className="font-mono text-[13px] text-pulse-muted ml-3">/ month</span>
          </div>
          <p className="text-[14px] text-pulse-bone/75 leading-[1.55] mb-6">
            Everything. One company. Unlimited teammates. BYO provider keys.
            Free while you&apos;re under $10k MRR.
          </p>
          <ul className="space-y-2 text-[13px] font-mono">
            <li>— Full Morning Brief + roster</li>
            <li>— Multi-provider routing</li>
            <li>— Single-tenant self-host (Fly.io)</li>
            <li>— Import / export companies</li>
          </ul>
          <div className="mt-8">
            <Link to="/auth" className="btn">
              Start free <span aria-hidden>→</span>
            </Link>
          </div>
        </div>

        <div className="p-8 md:p-10 bg-pulse-elev">
          <div className="flex items-center justify-between mb-4">
            <div className="font-mono caps-wide text-[10px] text-pulse-accent">Scale</div>
            <span className="font-mono caps text-[10px] text-pulse-muted">Coming soon</span>
          </div>
          <div
            className="font-display mb-6"
            style={{ fontSize: "clamp(2.5rem, 1.8rem + 2vw, 3.5rem)" }}
          >
            2%<span className="font-mono text-[13px] text-pulse-muted ml-3">of MRR above $10k</span>
          </div>
          <p className="text-[14px] text-pulse-bone/75 leading-[1.55] mb-6">
            Multi-company. Shared templates. Audit logs. SOC 2. The CEO seat
            stays free — you only pay when the company starts making money.
          </p>
          <ul className="space-y-2 text-[13px] font-mono">
            <li>— Multiple companies per workspace</li>
            <li>— Cross-company team templates</li>
            <li>— Compliance + audit</li>
            <li>— Priority provider access</li>
          </ul>
          <div className="mt-8">
            <a href="mailto:hello@founderos.ai" className="btn btn-ghost">
              Talk to us <span aria-hidden>→</span>
            </a>
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
  const items: Array<{ q: string; a: string }> = [
    {
      q: "Do I need to know how to code?",
      a: "No. You pick a template, plug in a provider, write one-line briefs. Your CEO teammate handles the rest — delegating work, running the standup, resolving blockers.",
    },
    {
      q: "What does it actually cost to run?",
      a: "The platform is free. You pay your provider directly — typically $50–500/mo depending on team size and activity. No per-seat pricing, no retainer, no lock-in.",
    },
    {
      q: "Can I export my company?",
      a: "Yes. One click produces a JSON template — your full org, goals, projects, starter backlog — that can be replayed into a fresh instance.",
    },
    {
      q: "Is my data private?",
      a: "Single-tenant by default. AES-256-GCM encrypted key vault. Deploy on Fly.io in one command or bring your own VPC. Your provider keys never leave your infra.",
    },
    {
      q: "What happens when a teammate gets stuck?",
      a: "They show up on the Morning Brief under \"Needs your call.\" You unblock with one message; the CEO teammate redirects the rest of the team accordingly.",
    },
  ];
  return (
    <section id="faq" className="mx-auto max-w-6xl px-6 md:px-10 py-24 md:py-32">
      <div className="grid grid-cols-12 gap-8 md:gap-12">
        <div className="col-span-12 md:col-span-4">
          <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-3">007 — QUESTIONS</div>
          <h2
            className="font-display"
            style={{ fontSize: "clamp(2.25rem, 1.4rem + 3vw, 3.5rem)" }}
          >
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
                  <h3
                    className="font-display flex-1"
                    style={{ fontSize: "clamp(1.25rem, 1.05rem + 0.5vw, 1.5rem)" }}
                  >
                    {it.q}
                  </h3>
                  <span className="font-mono caps-wide text-[10px] text-pulse-muted mt-1 shrink-0 group-open:text-pulse-accent">
                    {"+"}
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
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Contact — agency-style big sign-off
// ─────────────────────────────────────────────────────────────────────────

function Contact() {
  return (
    <section id="contact" className="mx-auto max-w-6xl px-6 md:px-10 py-28 md:py-40">
      <div className="font-mono caps-wide text-[10px] text-pulse-accent mb-6">008 — GO</div>
      <h2
        className="font-display"
        style={{ fontSize: "clamp(3rem, 1.6rem + 6vw, 8.5rem)" }}
      >
        Start your company.
        <br />
        <span className="font-display-italic text-pulse-accent">Hire your team.</span>
      </h2>
      <p className="mt-8 max-w-[56ch] text-[15px] text-pulse-bone/70 leading-[1.55]">
        Five minutes of setup. Bring your Claude, Codex, or Gemini key. You walk
        in as a solo operator and walk out running a company.
      </p>
      <div className="mt-12 flex flex-wrap items-center gap-4">
        <Link to="/auth" className="btn">
          Build your company <span aria-hidden>→</span>
        </Link>
        <a href="mailto:hello@founderos.ai" className="btn btn-ghost">
          Say hello <span aria-hidden>→</span>
        </a>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-pulse-line">
      <div className="mx-auto max-w-6xl px-6 md:px-10 py-10 flex items-center justify-between gap-4 flex-wrap font-mono text-[11px] text-pulse-muted">
        <div className="flex items-center gap-3">
          <FounderOSLogo size={16} />
          <span>© {new Date().getFullYear()} FounderOS</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="/legal/terms" className="hover:text-pulse-bone">Terms</a>
          <a href="/legal/privacy" className="hover:text-pulse-bone">Privacy</a>
          <a
            href="https://github.com/founderos-ai/founderos"
            target="_blank"
            rel="noreferrer"
            className="hover:text-pulse-bone"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}

function SectionRule() {
  return <div className="mx-auto max-w-6xl px-6 md:px-10"><div className="border-t border-pulse-line" /></div>;
}
