import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client singleton.
 *
 * Reads `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` at build time. Both are
 * safe to ship in the bundle — the anon key is designed for public clients and
 * the real access control lives in Postgres RLS on the server side.
 *
 * If either env is missing we still export a client pointing at placeholder
 * values so that typecheck + dev builds don't hard-fail — but every auth call
 * will error out at runtime, which surfaces the misconfiguration loudly
 * (preferred over silent auth success).
 */

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

if (!url || !anonKey) {
  // Dev visibility: a missing env at build time means auth won't work.
  // We intentionally don't throw — the bundle still needs to load so the
  // user sees the app chrome and can hit the error path.
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. Auth will fail until these are configured.",
  );
}

export const supabase: SupabaseClient = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  },
);

/**
 * Returns the current access token for outbound API calls.
 * null when there is no authenticated session.
 */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
