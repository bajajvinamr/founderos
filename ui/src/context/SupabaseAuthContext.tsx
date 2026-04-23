import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { queryKeys } from "@/lib/queryKeys";

interface SupabaseAuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextValue | null>(null);

/**
 * Subscribes to Supabase's auth state and exposes `{ user, session, loading,
 * signOut }`. Also invalidates the React Query session cache on every auth
 * change so that the existing `useQuery(queryKeys.auth.session, authApi.getSession)`
 * call sites (CloudAccessGate, Sidebar, etc.) stay in lockstep with Supabase.
 */
export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSession(data.session);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      setSession(nextSession);
      // Keep React Query's cached session in sync so downstream consumers
      // (CloudAccessGate, Sidebar, etc.) re-render on sign-in / sign-out.
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });

      // On sign-in: force an authenticated request against the backend so
      // the server-side actor middleware resolves the session and runs the
      // inline post-signup bootstrap (first-user-wins admin promotion).
      // Without this, the UI's `/api/health` call races the promotion and
      // BootstrapPendingPage flashes for new users (the symptom our cofounder
      // hit). Then invalidate the health query so CloudAccessGate re-checks
      // and sees bootstrapStatus: "ready".
      if (event === "SIGNED_IN" && nextSession?.access_token) {
        try {
          await fetch("/api/auth/get-session", {
            method: "GET",
            headers: { Authorization: `Bearer ${nextSession.access_token}` },
            credentials: "include",
          });
        } catch {
          // best-effort; health invalidation below still forces a recheck
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.health });
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [queryClient]);

  const value = useMemo<SupabaseAuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );

  return (
    <SupabaseAuthContext.Provider value={value}>{children}</SupabaseAuthContext.Provider>
  );
}

export function useSupabaseAuth(): SupabaseAuthContextValue {
  const ctx = useContext(SupabaseAuthContext);
  if (!ctx) {
    throw new Error("useSupabaseAuth must be used within a SupabaseAuthProvider");
  }
  return ctx;
}
