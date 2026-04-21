import { supabase } from "@/lib/supabase";

export type AuthSession = {
  session: { id: string; userId: string };
  user: { id: string; email: string | null; name: string | null };
};

/**
 * Auth API — Supabase backed.
 *
 * The session shape is kept compatible with the legacy better-auth
 * response so that the rest of the app (CloudAccessGate, etc.) does
 * not need to change. The `session.id` field maps to Supabase's
 * `access_token` (there's no first-class "session id" concept) and
 * `userId` maps to `user.id`.
 */
export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      throw new Error(error.message);
    }
    const session = data.session;
    if (!session) return null;
    const metadataName =
      (session.user.user_metadata as { full_name?: string; name?: string } | null)?.full_name ??
      (session.user.user_metadata as { full_name?: string; name?: string } | null)?.name ??
      null;
    return {
      session: {
        id: session.access_token,
        userId: session.user.id,
      },
      user: {
        id: session.user.id,
        email: session.user.email ?? null,
        name: metadataName,
      },
    };
  },

  signOut: async () => {
    await supabase.auth.signOut();
  },
};
