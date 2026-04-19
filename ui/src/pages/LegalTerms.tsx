import { FounderOSLogo } from "@/components/FounderOSLogo";
import { useNavigate } from "@/lib/router";

/**
 * Terms of Service. Shipping now so the buyer can point at a real URL on
 * the signup flow. Structured as plain boilerplate fit for a single-tenant
 * BYO-key SaaS that wraps MIT-licensed agent infrastructure.
 *
 * Not legal advice. Counsel should review before a paid launch.
 */
export function LegalTerms() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-3xl flex items-center justify-between px-6 h-14">
          <button type="button" onClick={() => navigate("/")} className="cursor-pointer" aria-label="Home">
            <FounderOSLogo size={20} />
          </button>
          <span className="text-xs text-muted-foreground uppercase tracking-[0.14em]">Terms of Service</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12 prose prose-slate dark:prose-invert prose-sm">
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-muted-foreground">Last updated: 2026-04-18.</p>

        <h2>1. What FounderOS is</h2>
        <p>
          FounderOS is a single-tenant AI company operating system. You sign up, pick a
          template, and spin up a company of AI agents that run on your Anthropic / OpenAI /
          Google credentials. We run the hosting layer; you bring the keys.
        </p>

        <h2>2. Accounts</h2>
        <p>
          To use FounderOS you need an account. You&apos;re responsible for keeping your
          credentials secure. If your account is used to break these terms (or the law),
          that&apos;s on you.
        </p>

        <h2>3. Bring-your-own-key (BYO-K) model</h2>
        <p>
          Agents run on AI provider credentials you supply (Anthropic, OpenAI, Google, or a
          subscription-authed CLI). Any API usage, token cost, rate limits, or policy
          violations originating from your agents are billed and adjudicated by the
          underlying provider, not FounderOS.
        </p>
        <p>
          We store your API keys encrypted at rest with AES-256-GCM via a per-instance
          master key. We never display a stored key after initial entry and never transmit
          it to any third party other than the provider it&apos;s intended for.
        </p>

        <h2>4. What your agents can do</h2>
        <p>
          Agents act under your direction and your provider credentials. You are responsible
          for what they produce, send, publish, or modify. FounderOS surfaces budget caps,
          approval flows, and spend controls — <strong>use them</strong>.
        </p>
        <p>
          You must not use FounderOS to build or run agents that violate applicable law,
          infringe third-party rights, generate CSAM / non-consensual sexual content,
          orchestrate harassment, or interfere with critical infrastructure.
        </p>

        <h2>5. Your data</h2>
        <p>
          Your company data (goals, agents, issues, heartbeat runs, cost events) lives in
          your deployed instance&apos;s database. In single-tenant deployments that&apos;s
          your own Postgres — we don&apos;t hold it. In managed deployments it lives on
          our infra; we back it up daily and never read it except when you ask us to debug.
        </p>
        <p>
          You can export everything via the portability API at any time. If you close
          your account, we delete non-backup data within 30 days.
        </p>

        <h2>6. Uptime &amp; availability</h2>
        <p>
          FounderOS is offered as-is. We aim for 99.5% uptime but make no contractual SLA
          unless you&apos;re on a Business plan with a signed SLA addendum.
        </p>

        <h2>7. Open source</h2>
        <p>
          FounderOS includes components under the MIT License. License attribution is
          preserved in the source tree — see{" "}
          <a href="https://github.com/founderos-ai/founderos/blob/main/NOTICE.md" target="_blank" rel="noreferrer">
            NOTICE.md
          </a>
          . You&apos;re free to fork or self-host under the MIT terms in those components.
        </p>

        <h2>8. Fees and billing</h2>
        <p>
          Managed-deployment pricing is described on the pricing page in effect when you
          sign up. You pay provider costs directly to Anthropic / OpenAI / Google. We bill
          only for hosting, templates, and managed services.
        </p>

        <h2>9. Liability</h2>
        <p>
          To the maximum extent permitted by law, FounderOS&apos; liability for any claim
          arising out of these terms is capped at the fees you paid us in the 3 months
          prior to the claim. We are not liable for loss of revenue, data, opportunity,
          or any indirect / consequential damages.
        </p>

        <h2>10. Changes</h2>
        <p>
          We may update these terms. Material changes get an email + in-app notice 14 days
          before they take effect. Continued use after the effective date = acceptance.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions? <a href="mailto:founders@founderos.ai">founders@founderos.ai</a>.
        </p>

        <hr />
        <p className="text-xs text-muted-foreground">
          These terms are starter boilerplate. If you&apos;re deploying FounderOS as a
          paid service, have counsel review before you launch.
        </p>
      </main>
    </div>
  );
}
