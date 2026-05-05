import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { branding } from "../branding";

interface BillingStatus {
  active: boolean;
  plan: string;
}

interface BillingGateProps {
  children: React.ReactNode;
}

export function BillingGate({ children }: BillingGateProps) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchBillingStatus() {
      try {
        setLoading(true);
        const response = await fetch("/api/billing/status");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as BillingStatus;
        setStatus(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch billing status";
        setError(message);
        // Fallback to active state on error so users aren't blocked
        setStatus({ active: true, plan: "free" });
      } finally {
        setLoading(false);
      }
    }

    fetchBillingStatus();
  }, []);

  // Show loading state
  if (loading) {
    return <div className="p-4">Loading billing status...</div>;
  }

  // If subscription is active, render children
  if (status?.active) {
    return <>{children}</>;
  }

  // Show billing gate card when inactive
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Subscription Required</CardTitle>
          <CardDescription>Upgrade to continue using {branding.productName}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-6 text-sm text-muted-foreground">
            You're currently on the <strong>free</strong> plan. Upgrade to unlock all features.
          </p>
          {error && <p className="mb-4 text-sm text-red-500">Error: {error}</p>}
          <Button
            className="w-full"
            onClick={() => {
              // Navigate to checkout
              window.location.href = "/api/billing/checkout";
            }}
          >
            Upgrade Now ($299/mo)
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">
            Cancel anytime. No hidden fees.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
