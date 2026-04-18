import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SignIn } from "@clerk/clerk-react";
import { authApi } from "@/api/auth";

/**
 * Renders Clerk's SignIn component when the server is configured with
 * Clerk as the auth provider; otherwise renders its children (the legacy
 * email/password form) untouched.
 *
 * Keeping both paths live lets dev + demo users keep using the embedded
 * email/password flow while production deployments switch on real Clerk
 * auth by setting CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY env vars.
 */
export function ClerkAuthPanel({
  children,
  nextPath,
}: {
  children: ReactNode;
  nextPath: string;
}) {
  const configQuery = useQuery({
    queryKey: ["auth", "config"],
    queryFn: () => authApi.getConfig(),
    staleTime: Infinity,
    retry: false,
  });

  // Config still loading — show the legacy form to avoid a flash.
  // Clerk activation is controlled by env at boot, so this decision is
  // stable for the session.
  if (configQuery.isLoading || !configQuery.data) return <>{children}</>;

  if (configQuery.data.provider !== "clerk") return <>{children}</>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to FounderOS</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          Sign in or create an account to spin up your first AI company.
        </p>
      </div>
      <SignIn
        routing="virtual"
        signUpUrl={`/auth?next=${encodeURIComponent(nextPath)}&mode=sign_up`}
        forceRedirectUrl={nextPath}
        appearance={{
          elements: {
            card: "shadow-none border border-border bg-card",
            formButtonPrimary:
              "bg-[var(--brand)] hover:bg-[var(--brand)]/90 text-[var(--primary-foreground)]",
          },
        }}
      />
    </div>
  );
}
