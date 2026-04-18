import { type ReactNode, useEffect, useState } from "react";
import { ClerkProvider } from "@clerk/clerk-react";
import { authApi } from "@/api/auth";

/**
 * Conditional Clerk shell.
 *
 * On boot, asks the server which auth provider is active via /api/auth/config.
 * If the server returns `{ provider: "clerk", publishableKey }`, wraps the
 * entire app in <ClerkProvider> so Clerk hooks (<SignIn />, useUser, etc.)
 * work. Otherwise renders children untouched — the legacy better-auth /
 * local_trusted paths keep working unchanged.
 *
 * During the initial config fetch we render children immediately to avoid
 * a flash-of-loading. If Clerk is later detected as enabled, the provider
 * wraps children on the next render — Clerk's own SDK handles delayed
 * initialization gracefully.
 */
export function ClerkShell({ children }: { children: ReactNode }) {
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.provider === "clerk" && cfg.publishableKey) {
          setPublishableKey(cfg.publishableKey);
        }
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        // On failure assume non-Clerk. The underlying app will render its
        // own error from the healthQuery anyway.
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Before we know the provider, render children so the app isn't blank.
  // Clerk activation is purely additive — if Clerk later lights up, we
  // wrap the children from that render onwards.
  if (!resolved || !publishableKey) return <>{children}</>;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={{
        variables: {
          colorPrimary: "oklch(0.5 0.07 193)",
          borderRadius: "0.5rem",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
