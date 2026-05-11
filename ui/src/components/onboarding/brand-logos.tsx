/**
 * BL-003 (P2.b, founder-language sweep) — Brand logos for ProviderTile.
 *
 * Inline SVG components for Anthropic / OpenAI / Google so the chooser
 * can show a recognizable brand mark instead of a generic lucide glyph.
 * Inline SVG keeps this Tier-1 — no new dependency, no asset pipeline,
 * `currentColor` fills respect Tailwind text-* utility classes the
 * caller passes through `className`.
 *
 * Three logos cover six tiles:
 *   Anthropic → claude_code, anthropic_api  (Claude family)
 *   OpenAI    → codex_cli, openai_api       (ChatGPT family)
 *   Google    → gemini_cli, google_api      (Gemini family)
 *
 * Marks are simplified, recognizable silhouettes (not pixel-perfect
 * brand-guideline tracings) — sized for a 16×16 tile slot at the same
 * `h-4 w-4` footprint the prior lucide icons used.
 */

import type { ComponentType } from "react";

interface LogoProps {
  className?: string;
}

/** Anthropic — three diagonal slashes (the simplified A-mark). */
export function AnthropicLogo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <title>Anthropic</title>
      {/* Three stylized slashes evoking the Anthropic A-mark. */}
      <path d="M8.8 5.6h4.6L21.2 26.4h-4.8l-1.6-4.4H8.4l-1.6 4.4H2zm.2 12.6h5.4L11.7 10z" />
      <path d="M22 5.6h4.6L30 26.4h-4.8z" />
    </svg>
  );
}

/** OpenAI — the six-petal knot mark, drawn from a single closed path. */
export function OpenAILogo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <title>OpenAI</title>
      {/* Simplified OpenAI hex-knot. Not the official trademark — a
          recognizable silhouette for the tile slot. */}
      <path d="M16 2c-3.1 0-5.8 1.8-7.1 4.5C5.9 7 3.5 9.3 3 12.4c-.5 3.1.8 6.1 3.2 7.9-.5 2.7.5 5.5 2.7 7.2 2.2 1.7 5.1 1.9 7.5.6 1.5 1.5 3.6 2.3 5.7 1.9 3.1-.5 5.5-2.8 6-5.9 1.5-1.5 2.3-3.5 1.9-5.6-.5-3.1-2.8-5.5-5.9-6-.5-1.5-1.5-2.8-2.9-3.7C19.8 7.6 18 7 16 7c0-2.8-2.2-5-5-5zm0 2.5c1.7 0 3.2 1.1 3.7 2.7l-7.4 4.3v-3.6c0-1.9 1.6-3.4 3.7-3.4zm6.5 6.4l-7.4 4.3-3.6-2.1 7.4-4.3c1.6-.9 3.6-.4 4.5 1.2.9 1.6.4 3.6-1.2 4.5l-.3.2zm-13.2 0c.4-.2.9-.3 1.4-.3v8.6l-3.1-1.8c-1.6-.9-2.2-3-1.2-4.6.4-.8 1.2-1.4 2.1-1.7zm6.9 4l3.6 2.1v4.2l-3.6 2.1-3.6-2.1v-4.2zm6.2 2.3l3.1 1.8c1.6.9 2.2 3 1.2 4.6-1 1.6-3 2.2-4.6 1.2v-3.4zm-9.8 5.6l3.6 2.1-7.4 4.3c-1.6.9-3.6.4-4.5-1.2-.9-1.6-.4-3.6 1.2-4.5z" />
    </svg>
  );
}

/** Google — the four-color "G" silhouette, drawn as a single mark. */
export function GoogleLogo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <title>Google</title>
      {/* Simplified G monogram — currentColor so it picks up the tile
          text color (mono treatment matches the other two marks). */}
      <path d="M16 5C9.9 5 5 9.9 5 16s4.9 11 11 11c5.5 0 10.1-4 10.9-9.3.1-.6-.4-1.2-1-1.2H17c-.6 0-1 .4-1 1v1.6c0 .6.4 1 1 1h5.8c-.9 2.5-3.3 4.4-6.3 4.4-3.6 0-6.6-3-6.6-6.6s3-6.6 6.6-6.6c1.6 0 3.1.6 4.3 1.6.4.4 1 .4 1.4 0l1.2-1.2c.4-.4.4-1.1 0-1.5C21.4 6 18.8 5 16 5z" />
    </svg>
  );
}

/**
 * Map from provider tile id (`PROVIDER_OPTIONS[].id`) to the brand
 * logo component. Keys MUST match the chooser registry exactly — if
 * a tile id isn't here, the chooser falls back to its lucide glyph.
 */
export const PROVIDER_BRAND_LOGOS: Record<
  string,
  ComponentType<{ className?: string }>
> = {
  claude_code: AnthropicLogo,
  anthropic_api: AnthropicLogo,
  gemini_cli: GoogleLogo,
  google_api: GoogleLogo,
  codex_cli: OpenAILogo,
  openai_api: OpenAILogo,
};
