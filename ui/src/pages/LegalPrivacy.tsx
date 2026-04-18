import { FounderOSLogo } from "@/components/FounderOSLogo";
import { useNavigate } from "@/lib/router";

/**
 * Privacy policy. Paired with Terms — both exist so signup flows that
 * require accepted legal pages can point at real URLs.
 *
 * Not legal advice. Counsel should review before a paid launch.
 */
export function LegalPrivacy() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-3xl flex items-center justify-between px-6 h-14">
          <button type="button" onClick={() => navigate("/")} className="cursor-pointer" aria-label="Home">
            <FounderOSLogo size={20} />
          </button>
          <span className="text-xs text-muted-foreground uppercase tracking-[0.14em]">Privacy Policy</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12 prose prose-slate dark:prose-invert prose-sm">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-muted-foreground">Last updated: 2026-04-18.</p>

        <h2>1. What we collect</h2>
        <ul>
          <li>
            <strong>Account info</strong> — email, name, auth provider (Clerk or
            better-auth). Stored in your instance database.
          </li>
          <li>
            <strong>Your company data</strong> — agents you created, goals, projects,
            issues, activity, and heartbeat runs. Stored in your instance database.
          </li>
          <li>
            <strong>API keys you store</strong> — AES-256-GCM-encrypted with your
            instance&apos;s master key before write. Never logged. Only the last 4
            characters are shown in the UI.
          </li>
          <li>
            <strong>Usage &amp; cost events</strong> — model, tokens, dollars per run.
            Aggregated on your dashboards; never sent upstream.
          </li>
          <li>
            <strong>Error telemetry</strong> — if you&apos;ve enabled Sentry in your
            deployment, stack traces from crashes are sent there. Otherwise they stay local.
          </li>
        </ul>

        <h2>2. What we don&apos;t collect</h2>
        <p>
          We don&apos;t read your agent conversations, your prompts, your customer data,
          or any file your agents create. FounderOS is a hosting + orchestration layer —
          the intelligence happens at the provider (Anthropic / OpenAI / Google) under
          your own contract with them.
        </p>

        <h2>3. Third parties that touch your data</h2>
        <ul>
          <li>
            <strong>Anthropic / OpenAI / Google</strong> — you send them prompts and
            receive completions using your own credentials. Their privacy policies apply.
          </li>
          <li>
            <strong>Clerk</strong> (if enabled) — handles your auth. Their SOC 2 + GDPR
            coverage applies to identity data.
          </li>
          <li>
            <strong>Supabase / your Postgres</strong> — holds your instance data at rest.
          </li>
          <li>
            <strong>Fly.io / your hosting provider</strong> — runs the server process.
          </li>
        </ul>

        <h2>4. Storage &amp; security</h2>
        <p>
          API keys are encrypted at rest with AES-256-GCM. The master key is stored in
          your deployment environment (not in the database), so a database dump alone
          cannot decrypt keys. Sessions use secure HTTP-only cookies.
        </p>
        <p>
          In single-tenant deployments, the database is yours — not ours. We have no
          visibility into it.
        </p>

        <h2>5. Data retention</h2>
        <p>
          Your data lives for as long as your instance lives. If you delete an account,
          we delete the associated rows within 30 days. Database backups persist up to
          90 days after which they&apos;re purged.
        </p>

        <h2>6. Export &amp; deletion</h2>
        <p>
          You can export everything at any time via the in-app export flow or the
          portability API. To request deletion, email{" "}
          <a href="mailto:privacy@founderos.ai">privacy@founderos.ai</a>.
        </p>

        <h2>7. Children</h2>
        <p>FounderOS is not intended for anyone under 16.</p>

        <h2>8. International users</h2>
        <p>
          Deployments are single-tenant. Your data resides in whatever region your
          hosting provider is configured for (we default to ap-south-1 Mumbai for Fly
          deployments; check your fly.toml).
        </p>

        <h2>9. Contact</h2>
        <p>
          Questions, corrections, deletion requests:{" "}
          <a href="mailto:privacy@founderos.ai">privacy@founderos.ai</a>.
        </p>

        <hr />
        <p className="text-xs text-muted-foreground">
          Boilerplate. If you&apos;re running FounderOS as a paid service serving EU or
          California users, have privacy counsel review for GDPR / CCPA specifics.
        </p>
      </main>
    </div>
  );
}
