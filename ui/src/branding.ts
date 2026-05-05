/**
 * Branding configuration. Buyers reselling this product can override any of
 * these via Vite env vars (VITE_BRANDING_*) at build time.
 */
export const branding = {
  productName: import.meta.env.VITE_BRANDING_PRODUCT_NAME ?? 'FounderOS',
  productTagline:
    import.meta.env.VITE_BRANDING_PRODUCT_TAGLINE ??
    'AI executive team in one workspace',
  docsUrl:
    import.meta.env.VITE_BRANDING_DOCS_URL ??
    'https://docs.founderos.ai',
} as const;
