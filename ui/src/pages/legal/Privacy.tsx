import { useEffect } from "react";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { ShieldAlert } from "lucide-react";

export function Privacy() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Privacy Policy" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Privacy Policy</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Last updated: April 21, 2026
        </p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">1. Information We Collect</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>We collect the following information to provide and improve FounderOS:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>
                <strong>Account Information:</strong> Email address, name, organization name, and
                password (hashed and salted)
              </li>
              <li>
                <strong>Usage Analytics:</strong> Feature usage, interaction patterns, and error
                logs (via PostHog if enabled)
              </li>
              <li>
                <strong>Technical Data:</strong> IP address, browser type, device type, and
                timestamps
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">2. What We Do NOT Collect</h2>
          <p className="text-muted-foreground">
            FounderOS does not have access to, store, or log:
          </p>
          <ul className="ml-4 space-y-1 list-disc text-muted-foreground">
            <li>LLM API prompts or completions sent through your account</li>
            <li>The contents of your API keys (we only store encrypted key material securely)</li>
            <li>Data processed by third-party LLM providers using your own credentials</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">3. How We Use Your Information</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>We use collected information to:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>Authenticate and authorize your access to FounderOS</li>
              <li>Provide, maintain, and improve the service</li>
              <li>Monitor system performance and detect fraud or abuse</li>
              <li>Send transactional emails (account confirmation, password reset, billing)</li>
              <li>Analyze usage patterns to improve features (with PostHog if opted in)</li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">4. Data Sharing and Subprocessors</h2>
          <p className="text-muted-foreground">
            We do not sell or rent your personal data. We may share information with trusted
            service providers:
          </p>
          <ul className="ml-4 space-y-1 list-disc text-muted-foreground">
            <li>
              <strong>Vercel:</strong> Application hosting (US-based data center)
            </li>
            <li>
              <strong>Fly.io or Railway:</strong> Backend API hosting
            </li>
            <li>
              <strong>PostgreSQL (Fly Managed):</strong> Database hosting
            </li>
            <li>
              <strong>PostHog:</strong> Optional analytics (EU or US, configurable per instance)
            </li>
            <li>
              <strong>Resend:</strong> Transactional email delivery
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">5. Data Retention</h2>
          <p className="text-muted-foreground">
            Account and usage data are retained for as long as your account is active. Upon account
            deletion, we retain backups for up to 90 days for disaster recovery purposes. After
            90 days, your personal data is permanently deleted, except where we are required to
            retain it by law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">6. Cookies and Tracking</h2>
          <p className="text-muted-foreground">
            We use essential cookies only:
          </p>
          <ul className="ml-4 space-y-1 list-disc text-muted-foreground">
            <li>
              <strong>Session Cookie:</strong> Maintains your authenticated session
            </li>
            <li>
              <strong>CSRF Token:</strong> Prevents cross-site request forgery attacks
            </li>
          </ul>
          <p className="text-muted-foreground mt-2">
            We do not use third-party tracking cookies, advertising pixels, or behavioral analytics
            by default. PostHog analytics are opt-in per instance.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">7. Your Rights</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>You have the right to:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>
                <strong>Access:</strong> Request a copy of your personal data
              </li>
              <li>
                <strong>Correct:</strong> Update inaccurate or incomplete information
              </li>
              <li>
                <strong>Delete:</strong> Request deletion of your account and associated data
              </li>
              <li>
                <strong>Withdraw Consent:</strong> Disable analytics tracking at any time
              </li>
              <li>
                <strong>Data Portability:</strong> Receive your data in a portable format
              </li>
            </ul>
          </div>
          <p className="text-muted-foreground mt-2">
            To exercise these rights, email{" "}
            <a
              href="mailto:privacy@founderos.ai"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              privacy@founderos.ai
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">8. GDPR and CCPA Compliance</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>
              <strong>GDPR (EU):</strong> We comply with the General Data Protection Regulation.
              Your data is processed on the lawful basis of contract performance (providing the service)
              and consent for analytics.
            </p>
            <p className="mt-2">
              <strong>CCPA (California):</strong> We comply with the California Consumer Privacy Act.
              You have the right to know what data we collect, delete it, and opt out of sale
              (we do not sell data, but you may opt out of analytics).
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">9. International Data Transfers</h2>
          <p className="text-muted-foreground">
            FounderOS is hosted on US servers (Vercel, Fly.io, Railway). If you are in the EU,
            your data may be transferred outside the EU. By using FounderOS, you consent to this
            transfer and acknowledge that your data is subject to US privacy laws.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">10. Changes to This Policy</h2>
          <p className="text-muted-foreground">
            We may update this privacy policy at any time. Changes take effect when posted.
            Continued use of FounderOS after changes constitutes acceptance of the updated policy.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">11. Contact</h2>
          <p className="text-muted-foreground">
            For privacy-related questions, contact{" "}
            <a
              href="mailto:privacy@founderos.ai"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              privacy@founderos.ai
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <p className="text-xs text-muted-foreground italic">
            See also: <a href="/terms" className="underline hover:no-underline">Terms of Service</a> and{" "}
            <a href="/security" className="underline hover:no-underline">Security Disclosure</a>
          </p>
        </section>
      </div>
    </div>
  );
}
