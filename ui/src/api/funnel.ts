import { api } from "./client";

/**
 * Wire-shape for a single funnel step.
 *
 * dropFromPrev is `null` for the top step (no previous) AND for any step
 * whose previous step had a count of 0 — surfacing "—" in the UI is more
 * accurate than rendering 0% or 100% from a degenerate division.
 */
export interface FunnelStep {
  name: string;
  count: number;
  dropFromPrev: number | null;
}

export interface FunnelDiagnostics {
  steps: FunnelStep[];
  /** Step name with the largest dropFromPrev. `null` when no step qualifies
   *  (empty workspace or all upstream counts zero). */
  worstStep: string | null;
}

export const funnelApi = {
  get: (companyId: string): Promise<FunnelDiagnostics> =>
    api.get(`/companies/${companyId}/funnel`),
};
