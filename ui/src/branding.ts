/**
 * Branding configuration. Buyers reselling this product can override any of
 * these via Vite env vars (VITE_BRANDING_*) at build time.
 *
 * `docsUrl` is intentionally nullable. We don't own `docs.founderos.ai` —
 * the previous hardcoded default rendered as a dead "Documentation" link
 * inside the signed-in app shell (Layout sidebar, SidebarNew footer).
 * Buyers reselling this product set `VITE_BRANDING_DOCS_URL=https://...`
 * at build time to surface their own docs link; if unset, every consumer
 * MUST hide its docs UI rather than render a broken anchor.
 */
const rawDocsUrl = import.meta.env.VITE_BRANDING_DOCS_URL;
const docsUrl: string | null =
  typeof rawDocsUrl === 'string' && rawDocsUrl.trim().length > 0
    ? rawDocsUrl.trim()
    : null;

export const branding = {
  productName: import.meta.env.VITE_BRANDING_PRODUCT_NAME ?? 'FounderOS',
  productTagline:
    import.meta.env.VITE_BRANDING_PRODUCT_TAGLINE ??
    'AI executive team in one workspace',
  docsUrl,
} as const;
