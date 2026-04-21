import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ApiError } from "../api/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorCode(err: unknown): "already_claimed" | "expired" | "auth_required" | "invalid" {
  if (!(err instanceof ApiError)) return "invalid";
  if (err.status === 401) return "auth_required";
  if (err.status === 404) return "invalid";
  if (err.status === 409) {
    const msg = err.message.toLowerCase();
    if (msg.includes("expired")) return "expired";
    if (msg.includes("claimed")) return "already_claimed";
    return "expired";
  }
  return "invalid";
}

// ---------------------------------------------------------------------------
// Layout shell — full-screen centered, no sidebar
// ---------------------------------------------------------------------------

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card sub-components
// ---------------------------------------------------------------------------

function Eyebrow({ label }: { label: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--brand,theme(colors.teal.600))]">
      {label}
    </p>
  );
}

function DisplayH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mt-2 font-serif text-[34px] leading-tight tracking-tight text-foreground">
      {children}
    </h1>
  );
}

function SubCopy({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/40">
      <p className="text-sm text-amber-800 dark:text-amber-300">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rotation hint modal (inline, no dependency on Dialog context)
// ---------------------------------------------------------------------------

function RotateHint({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Generate a new claim link
        </p>
        <h2 className="mt-2 text-lg font-semibold text-foreground">Rotate the claim challenge</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Stop the FounderOS server, then run the following command in your FounderOS environment.
          A fresh claim URL will be printed to stderr on the next startup.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
          {`pnpm founderos auth bootstrap-ceo`}
        </pre>
        <Button variant="outline" className="mt-5" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State: loading
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <PageShell>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-[var(--brand,theme(colors.teal.600))]" />
        Loading claim challenge…
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// State: malformed URL params
// ---------------------------------------------------------------------------

function InvalidParamsState() {
  return (
    <PageShell>
      <div className="rounded-xl border border-border bg-card p-8">
        <Eyebrow label="Error" />
        <DisplayH1>Invalid claim link</DisplayH1>
        <SubCopy>
          This URL is missing required parameters. Make sure you copied the full claim link from the
          server startup logs.
        </SubCopy>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// State: challenge fetch error (invalid / expired / already-claimed)
// ---------------------------------------------------------------------------

function ChallengeErrorState({
  code,
  message,
}: {
  code: "already_claimed" | "expired" | "invalid";
  message: string;
}) {
  const [showRotate, setShowRotate] = useState(false);

  if (code === "already_claimed") {
    return (
      <PageShell>
        <div className="rounded-xl border border-border bg-card p-8">
          <Eyebrow label="Already claimed" />
          <DisplayH1>This link has already been used.</DisplayH1>
          <SubCopy>
            This claim link was already redeemed. Sign in with the existing admin account to manage
            instance settings.
          </SubCopy>
          <div className="mt-7">
            <Button asChild>
              <Link to="/auth">Sign in</Link>
            </Button>
          </div>
        </div>
      </PageShell>
    );
  }

  if (code === "expired") {
    return (
      <PageShell>
        <div className="rounded-xl border border-border bg-card p-8">
          <Eyebrow label="Expired" />
          <DisplayH1>This claim link has expired.</DisplayH1>
          <SubCopy>
            Claim links are valid for 24 hours from server startup. Generate a new one with the
            command below.
          </SubCopy>
          <pre className="mt-5 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
            {`pnpm founderos auth bootstrap-ceo`}
          </pre>
        </div>
      </PageShell>
    );
  }

  // generic invalid
  return (
    <PageShell>
      <div className="rounded-xl border border-border bg-card p-8">
        <Eyebrow label="Error" />
        <DisplayH1>Claim challenge unavailable.</DisplayH1>
        <SubCopy>{message}</SubCopy>
        {showRotate && <RotateHint onClose={() => setShowRotate(false)} />}
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// State: signed-out gate
// ---------------------------------------------------------------------------

function SignedOutState({ currentPath }: { currentPath: string }) {
  return (
    <PageShell>
      <div className="rounded-xl border border-border bg-card p-8">
        <Eyebrow label="Instance Claim" />
        <DisplayH1>Claim instance admin</DisplayH1>
        <SubCopy>
          Claiming makes you the person who can manage integrations, configure provider keys,
          control instance-level settings, and invite other admins. You need to be signed in first.
        </SubCopy>
        <div className="mt-7">
          <Button asChild>
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>Sign in first</Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// State: confirm claim
// ---------------------------------------------------------------------------

interface ConfirmClaimProps {
  token: string;
  code: string;
  userEmail: string | null;
  onClaim: () => void;
  isPending: boolean;
  claimError: unknown;
  onSignOut: () => void;
}

function ConfirmClaimState({
  token,
  code,
  userEmail,
  onClaim,
  isPending,
  claimError,
  onSignOut,
}: ConfirmClaimProps) {
  const [showRotate, setShowRotate] = useState(false);
  const instanceHost = typeof window !== "undefined" ? window.location.host : "this instance";

  const errCode = claimError ? errorCode(claimError) : null;
  const errMsg = claimError instanceof Error ? claimError.message : null;

  return (
    <PageShell>
      <div className="rounded-xl border border-border bg-card p-8">
        <Eyebrow label="Instance Claim" />
        <DisplayH1>Become the admin of this instance.</DisplayH1>
        <SubCopy>
          You&rsquo;re about to take ownership of{" "}
          <span className="font-medium text-foreground">{instanceHost}</span>. Only one person can
          hold this role at a time. You&rsquo;ll get instance-level settings, integrations
          management, and the ability to invite other admins.
        </SubCopy>

        {/* Metadata */}
        <div className="mt-6 space-y-2 rounded-lg border border-border bg-muted/20 px-4 py-3">
          {userEmail && <MetaRow label="Signed in as" value={userEmail} />}
          <MetaRow label="Token" value={`${token.slice(0, 8)}…`} />
          <MetaRow label="Code" value={`${code.slice(0, 4)}…`} />
        </div>

        {/* Error block */}
        {errCode === "already_claimed" && (
          <ErrorBox message="This claim link has already been used. Sign in with the existing admin account." />
        )}
        {errCode === "expired" && (
          <>
            <ErrorBox message="This claim link has expired. Generate a new one to continue." />
            <button
              type="button"
              onClick={() => setShowRotate(true)}
              className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Request a new claim link
            </button>
          </>
        )}
        {errCode !== null && errCode !== "already_claimed" && errCode !== "expired" && (
          <>
            <ErrorBox message={errMsg ?? "Something went wrong. Please try again."} />
            <button
              type="button"
              onClick={() => setShowRotate(true)}
              className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Request a new claim link
            </button>
          </>
        )}

        {/* Actions */}
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            onClick={onClaim}
            disabled={isPending || errCode === "already_claimed" || errCode === "expired"}
          >
            {isPending ? "Claiming…" : "Claim this instance"}
          </Button>
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Not now, sign out
          </button>
        </div>
      </div>

      {showRotate && <RotateHint onClose={() => setShowRotate(false)} />}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// State: success
// ---------------------------------------------------------------------------

function SuccessState() {
  return (
    <PageShell>
      <div className="rounded-xl border border-border bg-card p-8">
        <Eyebrow label="Claimed" />
        <DisplayH1>You are the admin.</DisplayH1>
        <SubCopy>
          You can now manage instance integrations, configure provider keys, and invite other admins
          from Settings.
        </SubCopy>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button asChild>
            <Link to="/dashboard">Open Dashboard</Link>
          </Button>
          <Link
            to="/instance/settings/general"
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Go to Instance Settings
          </Link>
        </div>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Root page component
// ---------------------------------------------------------------------------

export function BoardClaimPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const token = (params.token ?? "").trim();
  const code = (searchParams.get("code") ?? "").trim();
  const currentPath = useMemo(
    () =>
      `/board-claim/${encodeURIComponent(token)}${code ? `?code=${encodeURIComponent(code)}` : ""}`,
    [token, code],
  );

  const [claimed, setClaimed] = useState(false);

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: ["board-claim", token, code],
    queryFn: () => accessApi.getBoardClaimStatus(token, code),
    enabled: token.length > 0 && code.length > 0,
    retry: false,
  });

  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBoard(token, code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await statusQuery.refetch();
      setClaimed(true);
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  // --- guard: malformed params ---
  if (!token || !code) {
    return <InvalidParamsState />;
  }

  // --- loading ---
  if (sessionQuery.isLoading || statusQuery.isLoading) {
    return <LoadingState />;
  }

  // --- status-query fetch error ---
  if (statusQuery.error) {
    const code_ = errorCode(statusQuery.error);
    const msg =
      statusQuery.error instanceof Error
        ? statusQuery.error.message
        : "Challenge is invalid or expired.";
    return (
      <ChallengeErrorState
        code={code_ === "auth_required" ? "invalid" : code_}
        message={msg}
      />
    );
  }

  // --- status resolved from the status query (GET-level already-claimed) ---
  const status = statusQuery.data;
  if (status?.status === "claimed" && !claimed) {
    return (
      <ChallengeErrorState
        code="already_claimed"
        message="This claim link has already been used."
      />
    );
  }
  if (status?.status === "expired") {
    return <ChallengeErrorState code="expired" message="This claim link has expired." />;
  }

  // --- success (post-claim) ---
  if (claimed) {
    return <SuccessState />;
  }

  // --- signed-out gate ---
  const session = sessionQuery.data;
  if (!session) {
    return <SignedOutState currentPath={currentPath} />;
  }

  // --- confirm claim ---
  return (
    <ConfirmClaimState
      token={token}
      code={code}
      userEmail={session.user.email}
      onClaim={() => claimMutation.mutate()}
      isPending={claimMutation.isPending}
      claimError={claimMutation.error}
      onSignOut={() => signOutMutation.mutate()}
    />
  );
}
