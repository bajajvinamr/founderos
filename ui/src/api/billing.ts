import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

/**
 * Subscription status surface — mirrors the server's GET /api/billing/status
 * envelope. `active` is the gate the BillingGate component reads; `plan` and
 * `status` are surfaced on dashboards.
 *
 * Sprint 3 / TC-2 (council 2026-05-05 P2 — growth mock exorcism): the
 * GrowthConsole reads `active` to decide between rendering mock-preview data
 * (free / trial — acceptable demo) vs the integration-connection CTA (paid —
 * mock data is a trust violation on a paid surface).
 */
export interface BillingStatus {
  active: boolean;
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  stripeConfigured: boolean;
}

export const billingApi = {
  getStatus: () => api.get<BillingStatus>("/billing/status"),
};

/**
 * React Query hook for billing status. Used by BillingGate (full-screen
 * subscription gate) and the GrowthConsole (paid-tier UX differentiation).
 *
 * Defaults are intentional:
 *   - `staleTime: 60s` — billing status doesn't churn within a minute. The
 *     Stripe webhook updates the row asynchronously; a 60s stale window keeps
 *     the dashboard from hitting /api/billing/status on every navigation.
 *   - `retry: 1` — billing status is best-effort. A failure shouldn't block
 *     the UI from rendering (the hook surfaces `isLoading` so the caller can
 *     decide what to do with an unresolved state).
 */
export function useBillingStatus() {
  return useQuery({
    queryKey: ["billing", "status"],
    queryFn: () => billingApi.getStatus(),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Returns `true` when the caller is on a paid (active or trialing) plan.
 *
 * Loading-state semantics (council 2026-05-05 P2 trust gate):
 *   - `isLoading: true` until the first /api/billing/status response.
 *   - On error / never-loaded: `isPaid` falls back to `false`. This is
 *     intentional: a billing-API outage SHOULD let a (presumed-trial)
 *     user keep using the dashboard with demo previews. The corresponding
 *     server-side gate at /api/onboarding/bootstrap also fails open on
 *     a billing-status error, for the same reason.
 *
 * Callers that must avoid showing demo data to a maybe-paid user during
 * the loading window should branch on `isLoading` AND `isPaid` together,
 * preferring an empty / skeleton state on `isLoading`. The GrowthConsole
 * uses the simpler `isPaid` reading — the demo-data flash on initial load
 * is bounded by react-query's request latency (typically &lt;200 ms on a
 * warm cache) and is preferable to a blank page on cold load.
 */
export function useIsPaidPlan(): { isPaid: boolean; isLoading: boolean } {
  const { data, isLoading } = useBillingStatus();
  return {
    isPaid: !!data?.active,
    isLoading,
  };
}
