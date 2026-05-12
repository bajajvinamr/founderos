import { useEffect } from "react";

/**
 * Flip the global <meta name="robots"> tag to `noindex` while the consuming
 * route is mounted, restoring the prior value on unmount. Used on user-specific
 * routes (`/auth`, `/invite/*`, `/cli-auth/*`) so they never get indexed by
 * search engines even when accessed via direct link.
 *
 * Mutates the existing tag in-place rather than appending a second one —
 * search-engine crawlers honour the most-restrictive directive, but having
 * exactly one tag avoids ambiguity and stale state on client-side navigation.
 */
export function useNoIndex(): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!meta) return;

    const previous = meta.getAttribute("content");
    meta.setAttribute("content", "noindex");

    return () => {
      if (previous === null) {
        meta.removeAttribute("content");
      } else {
        meta.setAttribute("content", previous);
      }
    };
  }, []);
}
