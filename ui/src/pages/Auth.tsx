import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FounderOSLogo } from "@/components/FounderOSLogo";
import { supabase } from "@/lib/supabase";
import { useSupabaseAuth } from "@/context/SupabaseAuthContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

type AuthMode = "sign_in" | "sign_up";

export function AuthPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();
  const { session, loading: sessionLoading } = useSupabaseAuth();

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);

  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    null | "email" | "google" | "magic"
  >(null);

  useEffect(() => {
    if (sessionLoading) return;
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, sessionLoading, navigate, nextPath]);

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const isBusy = pendingAction !== null;

  async function handleEmailSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return;
    setError(null);
    setInfo(null);
    if (!canSubmit) {
      setError(
        mode === "sign_up"
          ? "Please fill in all fields. Password must be at least 8 characters."
          : "Please enter your email and password.",
      );
      return;
    }

    setPendingAction("email");
    try {
      if (mode === "sign_in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: name.trim() },
            emailRedirectTo: `${window.location.origin}/auth?next=${encodeURIComponent(nextPath)}`,
          },
        });
        if (signUpError) throw signUpError;
        // When email confirmation is on, data.session will be null and we
        // prompt the user to check their inbox instead of navigating.
        if (!data.session) {
          setInfo("Check your email to confirm your account.");
          setPendingAction(null);
          return;
        }
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      setError(message);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleGoogle() {
    if (isBusy) return;
    setError(null);
    setInfo(null);
    setPendingAction("google");
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth?next=${encodeURIComponent(nextPath)}`,
        },
      });
      if (oauthError) throw oauthError;
      // Supabase redirects the browser; control won't return here. Leave
      // pendingAction set so the button remains in its loading state.
    } catch (err) {
      const message = err instanceof Error ? err.message : "Google sign-in failed";
      setError(message);
      setPendingAction(null);
    }
  }

  async function handleMagicLink() {
    if (isBusy) return;
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError("Enter your email to get a magic link.");
      return;
    }
    setPendingAction("magic");
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth?next=${encodeURIComponent(nextPath)}`,
        },
      });
      if (otpError) throw otpError;
      setInfo("Magic link sent. Check your email.");
      pushToast({ title: "Magic link sent", body: "Check your email to finish signing in.", tone: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not send magic link";
      setError(message);
    } finally {
      setPendingAction(null);
    }
  }

  if (sessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-10">
            <FounderOSLogo size={22} />
          </div>

          <h1 className="font-display text-2xl tracking-tight">
            {mode === "sign_in" ? "Welcome back" : "Start your company"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            {mode === "sign_in"
              ? "Sign in to your FounderOS instance."
              : "Create your account. You'll pick a company template and plug in your Anthropic key on the next step."}
          </p>

          {/* Tab toggle */}
          <div className="mt-6 inline-flex rounded-md border border-border p-0.5 text-xs">
            <button
              type="button"
              disabled={isBusy}
              className={`px-3 py-1.5 rounded-[5px] font-medium transition-colors ${
                mode === "sign_in"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setMode("sign_in");
                setError(null);
                setInfo(null);
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              disabled={isBusy}
              className={`px-3 py-1.5 rounded-[5px] font-medium transition-colors ${
                mode === "sign_up"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setMode("sign_up");
                setError(null);
                setInfo(null);
              }}
            >
              Sign up
            </button>
          </div>

          {/* Google OAuth — primary entry point */}
          <div className="mt-6">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full gap-3"
              onClick={handleGoogle}
              disabled={isBusy}
            >
              {pendingAction === "google" ? (
                <Spinner />
              ) : (
                <GoogleLogo />
              )}
              <span>Continue with Google</span>
            </Button>
          </div>

          {/* Divider */}
          <div className="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            <span>or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleEmailSubmit}>
            {mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">
                  Name
                </label>
                <Input
                  id="name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </div>
            )}
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
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="text-xs text-muted-foreground block">
                  Password
                </label>
                {mode === "sign_in" && (
                  <Link
                    to="/auth/forgot"
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
              />
              {mode === "sign_up" && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  At least 8 characters.
                </p>
              )}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {info && <p className="text-xs text-[var(--brand)]">{info}</p>}

            <Button
              type="submit"
              disabled={isBusy}
              aria-disabled={!canSubmit || isBusy}
              className={`w-full ${!canSubmit && !isBusy ? "opacity-50" : ""}`}
            >
              {pendingAction === "email" ? (
                <Spinner />
              ) : mode === "sign_in" ? (
                "Sign in"
              ) : (
                "Create account"
              )}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
              onClick={handleMagicLink}
              disabled={isBusy}
            >
              {pendingAction === "magic" ? "Sending magic link…" : "Send me a magic link instead"}
            </button>
          </div>

          <div className="mt-6 text-xs text-muted-foreground text-center">
            By continuing you agree to our{" "}
            <a
              href="/legal/terms"
              className="text-foreground underline underline-offset-2 decoration-muted-foreground/40"
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              href="/legal/privacy"
              className="text-foreground underline underline-offset-2 decoration-muted-foreground/40"
            >
              Privacy Policy
            </a>
            .
          </div>
        </div>
      </div>

      {/* Right half — brand panel (hidden on mobile) */}
      <aside
        className="hidden md:flex w-1/2 overflow-hidden relative flex-col justify-between p-14"
        style={{
          background:
            "linear-gradient(145deg, color-mix(in oklch, var(--brand) 22%, var(--background)) 0%, var(--background) 55%, color-mix(in oklch, var(--brand) 10%, var(--background)) 100%)",
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
          }}
        />
        <div className="relative">
          <FounderOSLogo size={20} />
        </div>
        <div className="relative max-w-lg">
          <div className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-6">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
            For the next generation of founders
          </div>
          <h2 className="font-display text-[44px] md:text-[56px] leading-[1.02] tracking-tight text-foreground">
            Run a company
            <br />
            <span className="font-display-italic text-[var(--brand)]">staffed by AI.</span>
          </h2>
          <p className="mt-6 text-[15px] text-muted-foreground leading-[1.65]">
            A CEO, a CTO, a head of growth, an ops lead — everyone reporting into one
            org chart, working on real goals, on the providers you already pay for.
            Live in under five minutes.
          </p>
          <div className="mt-10 grid grid-cols-3 gap-6">
            <Stat label="Providers" value="3" sub="Claude, Codex, Gemini — CLI or API" />
            <Stat label="Onboarding" value="<5m" sub="Template → providers → launch" />
            <Stat label="Tenancy" value="Single" sub="One isolated instance per founder" />
          </div>
        </div>
        <div className="relative text-xs text-muted-foreground space-y-1">
          <div>BYO provider keys · Your data, your infra</div>
          <div className="flex items-center gap-2 text-[11px]">
            <a href="/legal/terms" className="hover:text-foreground underline underline-offset-2 decoration-muted-foreground/40">Terms</a>
            <span className="text-muted-foreground/50">·</span>
            <a href="/legal/privacy" className="hover:text-foreground underline underline-offset-2 decoration-muted-foreground/40">Privacy</a>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-l-2 border-[color:color-mix(in_oklch,var(--brand)_40%,transparent)] pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground leading-snug">{sub}</div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin"
    />
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}
