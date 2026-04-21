import { type ReactNode } from "react";

/**
 * Legacy Clerk auth panel — neutralized in Wave 13B when auth migrated to
 * Supabase. Now a pass-through so it can be removed in a later wave
 * without touching call sites.
 */
export function ClerkAuthPanel({ children }: { children: ReactNode; nextPath?: string }) {
  return <>{children}</>;
}
