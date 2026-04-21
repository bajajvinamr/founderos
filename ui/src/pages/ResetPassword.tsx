import { useEffect, useState } from "react";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FounderOSLogo } from "@/components/FounderOSLogo";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/context/ToastContext";

export function ResetPassword() {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Supabase lands here with a recovery session in the URL hash. Because we
  // set `detectSessionInUrl: true` on the client, the SDK parses that hash
  // automatically — we just need to verify a session exists before letting
  // the user set a new password.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        setError(
          "Your reset link has expired or is invalid. Request a new one from the forgot password page.",
        );
      }
      setReady(true);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      pushToast({
        title: "Password updated",
        body: "You're signed in with your new password.",
        tone: "success",
      });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8 py-12">
        <div className="mb-10">
          <FounderOSLogo size={22} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Pick something you haven't used before — at least 8 characters.
        </p>

        {!ready ? (
          <div className="mt-6 text-sm text-muted-foreground">Verifying reset link…</div>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">
                New password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="confirm" className="text-xs text-muted-foreground mb-1 block">
                Confirm new password
              </label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
