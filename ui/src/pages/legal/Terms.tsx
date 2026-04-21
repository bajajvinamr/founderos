import { useEffect } from "react";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { FileText } from "lucide-react";

export function Terms() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Terms of Service" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Terms of Service</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Last updated: April 21, 2026
        </p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">1. Acceptance of Terms</h2>
          <p className="text-muted-foreground">
            By accessing and using FounderOS, you agree to be bound by these Terms of Service.
            If you do not agree with any part of these terms, you may not use this service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">2. Account Registration and Responsibility</h2>
          <p className="text-muted-foreground">
            You are responsible for maintaining the confidentiality of your account credentials
            and for all activities that occur under your account. You agree to provide accurate
            and complete information during registration and to notify us immediately of any
            unauthorized access to your account.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">3. Bring-Your-Own-Key (BYOK) Policy</h2>
          <p className="text-muted-foreground">
            FounderOS does not process, store, or have access to your LLM API keys beyond
            secure credential storage. When you provide your own API key (e.g., for Anthropic Claude),
            all prompts and completions go directly from our client to the respective LLM provider
            using your credentials. FounderOS does not see, log, or retain the content of your
            prompts or completions. You remain responsible for managing your API key usage,
            costs, and rate limits with your LLM provider.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">4. Acceptable Use</h2>
          <p className="text-muted-foreground">
            You agree not to use FounderOS for any unlawful purpose or in any way that could
            damage, disable, overburden, or impair the service. This includes but is not limited
            to: attempting to gain unauthorized access, reverse engineering, or distributing
            malware. You are responsible for all content you create and transmit using your account.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">5. Service Availability and Uptime</h2>
          <p className="text-muted-foreground">
            FounderOS is provided on an "as-is" basis. Free tier users receive no service level
            agreement (SLA) or guaranteed uptime. We make reasonable efforts to maintain service
            availability, but do not guarantee uninterrupted or error-free operation. Planned
            maintenance may occur without notice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">6. Intellectual Property</h2>
          <p className="text-muted-foreground">
            FounderOS and its original content are the exclusive property of FounderOS Labs.
            You retain all rights to your content. By using the service, you grant us a limited
            license to process and display your content solely to provide the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">7. Limitation of Liability</h2>
          <p className="text-muted-foreground">
            To the maximum extent permitted by law, FounderOS and its founders shall not be
            liable for any indirect, incidental, special, consequential, or punitive damages,
            or loss of profits, revenue, data, or use. Our total liability shall not exceed
            the amount of fees paid by you in the twelve months preceding the claim. Some
            jurisdictions do not allow the exclusion of implied warranties, so this limitation
            may not apply to you.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">8. Termination</h2>
          <p className="text-muted-foreground">
            We may terminate or suspend your account at any time, with or without cause, and
            with or without notice. Upon termination, your right to use FounderOS ceases
            immediately. You may request deletion of your account at any time through your
            account settings.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">9. Dispute Resolution</h2>
          <p className="text-muted-foreground">
            Any dispute arising out of or relating to these Terms shall be resolved by binding
            arbitration in Santa Clara County, California, administered by JAMS. Each party
            shall bear its own costs and attorneys' fees. Notwithstanding the foregoing, either
            party may seek injunctive relief to prevent irreparable harm.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">10. Governing Law</h2>
          <p className="text-muted-foreground">
            These Terms of Service are governed by and construed in accordance with the laws of
            the State of California, without regard to its conflicts of law principles.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">11. Changes to Terms</h2>
          <p className="text-muted-foreground">
            We reserve the right to modify these terms at any time. Changes will be effective
            when posted to this page, and your continued use of FounderOS constitutes acceptance
            of the updated terms. If you do not agree with changes, you should stop using the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">12. Contact</h2>
          <p className="text-muted-foreground">
            For questions about these Terms, please contact us at{" "}
            <a
              href="mailto:legal@founderos.ai"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              legal@founderos.ai
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <p className="text-xs text-muted-foreground italic">
            See also: <a href="/privacy" className="underline hover:no-underline">Privacy Policy</a> and{" "}
            <a href="/security" className="underline hover:no-underline">Security Disclosure</a>
          </p>
        </section>
      </div>
    </div>
  );
}
