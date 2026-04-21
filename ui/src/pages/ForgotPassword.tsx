import { useState } from "react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FounderOSLogo } from "@/components/FounderOSLogo";
import { supabase } from "@/lib/supabase";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (!email.trim()) {
      setError("Enter your email.");
      return;
    }
    setPending(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        {
          redirectTo: `${window.location.origin}/auth/reset`,
        },
      );
      if (resetError) throw resetError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send reset email.");
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
        <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Enter your email and we'll send you a link to reset it.
        </p>

        {sent ? (
          <div className="mt-6 rounded-md border border-border bg-card p-4 text-sm">
            <p className="text-foreground">Check your email.</p>
            <p className="mt-1 text-muted-foreground">
              If an account exists for <span className="text-foreground">{email}</span>,
              we just sent a reset link. The link expires in one hour.
            </p>
            <div className="mt-4">
              <Link
                to="/auth"
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Send reset link"}
            </Button>
            <div className="text-center">
              <Link
                to="/auth"
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
