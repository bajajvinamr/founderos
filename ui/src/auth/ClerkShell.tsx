import { type ReactNode } from "react";

/**
 * Legacy Clerk shell — neutralized in Wave 13B when auth migrated to Supabase.
 *
 * Kept as a pass-through to avoid churn in `main.tsx` and any other call
 * sites; will be deleted once Clerk is fully removed from the tree.
 */
export function ClerkShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
