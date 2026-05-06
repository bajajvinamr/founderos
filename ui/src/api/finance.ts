import { api } from "./client";

/**
 * Revenue cockpit (S5.1) — read-only metrics view.
 *
 * Shape mirrors `CockpitMetrics` from server/services/finance/cockpit.ts.
 * Kept as a UI-side type for now; promote to @founderos/shared when a
 * second consumer (CLI, plugin) needs it.
 */
export type Confidence = "high" | "medium" | "low" | "insufficient_data";

export interface CockpitMetrics {
  mrr: { cents: number; deltaPctMoM: number; confidence: Confidence };
  arr: { cents: number };
  expansion: { cents: number; source: "stripe_events" };
  churn: { rate30dPct: number; lostMrrCents: number; confidence: Confidence };
  ltv: { cents: number; sampleSize: number; confidence: Confidence };
  cac: {
    cents: number | null;
    channelBreakdown: Array<{
      channel: string;
      cac: number;
      spendCents: number;
      signups: number;
    }>;
    confidence: Confidence;
    note: string | null;
  };
  paybackMonths: { value: number | null; confidence: Confidence };
  grossMarginPct: { value: number; assumed: boolean };
  customerCount: { total: number; paying: number; free: number };
  arpu: { cents: number };
  cash: { cents: number | null; runwayMonths: number | null };
}

export interface ScenarioKeyNumber {
  label: string;
  value: string;
  delta?: string;
}

export interface ScenarioResponse {
  headline: string;
  narrative: string;
  keyNumbers: ScenarioKeyNumber[];
  warnings: string[];
  toolsUsed: string[];
}

export interface ScenarioRunResult {
  response: ScenarioResponse;
  steps: number;
  toolCalls: Array<{ name: string; isError: boolean }>;
}

export const financeApi = {
  cockpit: (companyId: string) =>
    api.get<CockpitMetrics>(`/companies/${companyId}/finance/cockpit`),
  scenario: (companyId: string, question: string) =>
    api.post<ScenarioRunResult>(
      `/companies/${companyId}/finance/scenario`,
      { question },
    ),
};
