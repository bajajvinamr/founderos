# Branding Configuration

FounderOS uses a tenant-agnostic branding config that allows buyers to rebrand the product for resale.

## Overriding Branding at Build Time

All branding strings are defined in `ui/src/branding.ts`. To override them, set environment variables at build time:

```bash
# Example: rebranding as "Acme Executive Suite"
VITE_BRANDING_PRODUCT_NAME=Acme \
VITE_BRANDING_PRODUCT_TAGLINE="Operational command center for startups" \
VITE_BRANDING_DOCS_URL=https://docs.acme.com \
pnpm --filter @founderos/ui build
```

## Available Variables

| Variable | Default | Used for |
|---|---|---|
| `VITE_BRANDING_PRODUCT_NAME` | `FounderOS` | Product name in browser title, top bar, login flow |
| `VITE_BRANDING_PRODUCT_TAGLINE` | `AI executive team in one workspace` | Onboarding welcome screen, marketing pages |
| `VITE_BRANDING_DOCS_URL` | `https://docs.founderos.ai` | Help links, documentation references |

## Development

For local development, you can set these in a `.env.local` file:

```
VITE_BRANDING_PRODUCT_NAME=My Rebrand
VITE_BRANDING_PRODUCT_TAGLINE=My custom tagline
VITE_BRANDING_DOCS_URL=https://my-docs.com
```

Then run `pnpm dev` — the dev server will pick up the overrides immediately.

## Notes

- Branding strings in marketing pages, auth pages, legal docs, and tests are **not** overridable and should be customized wholesale by the buyer.
- Only core product UI (dashboard, agent flows, settings, sidebar, alerts, etc.) uses the branding config.
- The override mechanism uses Vite's `import.meta.env`, so values are baked into the build and cannot be changed at runtime.
