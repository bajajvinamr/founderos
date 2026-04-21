import { useEffect } from "react";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { Lock } from "lucide-react";

export function Security() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Security Disclosure" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Security Disclosure</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Last updated: April 21, 2026
        </p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">1. Responsible Disclosure</h2>
          <p className="text-muted-foreground">
            At FounderOS, we take security seriously. If you discover a security vulnerability,
            please report it responsibly by emailing{" "}
            <a
              href="mailto:security@founderos.ai"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              security@founderos.ai
            </a>
            . Do not disclose the vulnerability publicly or attempt to exploit it.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">2. Report Response Time</h2>
          <p className="text-muted-foreground">
            We commit to acknowledging security reports within 24 hours and providing a timeline
            for resolution. Confirmed vulnerabilities will be patched promptly, typically within
            7-14 days depending on severity.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">3. Encryption in Transit</h2>
          <p className="text-muted-foreground">
            All communication between your browser and FounderOS servers is encrypted using
            TLS 1.2 or higher. We enforce HTTPS on all pages. Unencrypted HTTP connections
            are automatically redirected to HTTPS.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">4. Encryption at Rest</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>Sensitive data is encrypted at rest using industry-standard methods:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>
                <strong>API Keys Column:</strong> Encrypted with AES-256-GCM using the instance
                master key. Keys are not accessible even to database administrators without the
                master key.
              </li>
              <li>
                <strong>Database Backups:</strong> Encrypted and stored securely with restricted access
              </li>
              <li>
                <strong>Passwords:</strong> Hashed using bcrypt with a cost factor of 12
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">5. Authentication and Session Security</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>FounderOS uses secure authentication mechanisms:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>
                <strong>Password Requirements:</strong> Email and password authentication with
                configurable password policies
              </li>
              <li>
                <strong>Session Tokens:</strong> Secure, httpOnly cookies to prevent XSS token theft
              </li>
              <li>
                <strong>SameSite Cookies:</strong> Set to Lax to prevent CSRF attacks
              </li>
              <li>
                <strong>Token Expiration:</strong> Sessions expire after 30 days of inactivity
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">6. BYOK (Bring-Your-Own-Key) Security</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>When you provide your own LLM API key:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>Keys are encrypted with AES-256-GCM before storage</li>
              <li>Decryption happens only when needed to make API calls on your behalf</li>
              <li>Keys are never logged, cached in plaintext, or transmitted to third parties</li>
              <li>
                Prompts and completions bypass our servers entirely and go directly from your
                browser to the LLM provider
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">7. Data Access Controls</h2>
          <p className="text-muted-foreground">
            Access to FounderOS databases and systems is restricted to authorized personnel only.
            All administrative access is logged and monitored. We follow the principle of least
            privilege—employees have access only to the systems they need to perform their role.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">8. Incident Response</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>In the event of a security breach involving personal data:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>Affected users will be notified within 72 hours</li>
              <li>An incident report will be posted to our status page</li>
              <li>
                We will provide details on what data was compromised, steps we took to remediate,
                and recommended actions for users
              </li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">9. Vulnerability Scanning and Penetration Testing</h2>
          <p className="text-muted-foreground">
            FounderOS undergoes regular vulnerability scans and periodic penetration testing.
            Dependencies are monitored for known vulnerabilities and patched promptly.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">10. Third-Party Security</h2>
          <p className="text-muted-foreground">
            We rely on trusted third-party providers for hosting and services. These providers
            undergo regular security audits and maintain SOC 2 or equivalent certifications.
            See our Privacy Policy for a full list of subprocessors.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">11. Security Best Practices for Users</h2>
          <div className="space-y-2 text-muted-foreground">
            <p>To protect your FounderOS account:</p>
            <ul className="ml-4 space-y-1 list-disc">
              <li>Use a strong, unique password (12+ characters, mix of case, numbers, symbols)</li>
              <li>Never share your password or API keys with anyone</li>
              <li>Regularly rotate your LLM provider API keys</li>
              <li>Log out from shared computers</li>
              <li>Enable any available multi-factor authentication if offered</li>
            </ul>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">12. Contact</h2>
          <p className="text-muted-foreground">
            For security concerns or to report a vulnerability, email{" "}
            <a
              href="mailto:security@founderos.ai"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              security@founderos.ai
            </a>
            . Please include:
          </p>
          <ul className="ml-4 space-y-1 list-disc text-muted-foreground">
            <li>Description of the vulnerability</li>
            <li>Steps to reproduce (if applicable)</li>
            <li>Potential impact</li>
            <li>Your contact information</li>
          </ul>
        </section>

        <section className="space-y-3">
          <p className="text-xs text-muted-foreground italic">
            See also: <a href="/terms" className="underline hover:no-underline">Terms of Service</a> and{" "}
            <a href="/privacy" className="underline hover:no-underline">Privacy Policy</a>
          </p>
        </section>
      </div>
    </div>
  );
}
