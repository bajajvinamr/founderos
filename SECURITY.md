# Security Policy

## Supported Versions

We provide security updates for the **main branch only**. Releases are deployed to production automatically; we recommend staying on the latest version.

| Version | Supported          |
|---------|-------------------|
| main    | :white_check_mark: |
| Others  | :x:                |

## Reporting a Vulnerability

**Please do NOT open a public issue for security vulnerabilities.**

If you discover a vulnerability, please email:

```
security@founderos.ai
```

Include:
- Description of the vulnerability
- Affected version(s) or components
- Steps to reproduce (if applicable)
- Potential impact

**Expected response timeline:** Acknowledgement within 48 hours. We will work to provide a fix, patch, or remediation within 5 business days for critical issues.

## Vulnerability Scope

### In Scope
- Vulnerabilities in the hosted FounderOS application
- Vulnerabilities in the self-hosted template and deployment automation
- Sensitive data exposure, authentication/authorization bypasses
- Injection attacks (SQL, NoSQL, template, etc.)
- Cryptographic failures

### Out of Scope
- Vulnerabilities in third-party SaaS services we integrate with (Stripe, Supabase, etc.)
- Issues in documentation-only repositories
- Social engineering or phishing attacks
- Denial of service attacks against free tier services
- Publicly known vulnerabilities without a novel attack vector

## Security Practices

- **Automated scanning:** Gitleaks and CodeQL analyze every push
- **Dependency management:** Dependabot checks for vulnerable packages weekly
- **Secrets rotation:** Exposed secrets are rotated immediately
- **Public disclosure:** Fixed vulnerabilities are credited in release notes after a grace period

## Credits

Thank you to the security researchers who responsibly disclose vulnerabilities. We will provide credit in our release notes when you help us improve FounderOS.
