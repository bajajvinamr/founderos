import type { DashboardSummary } from "@founderos/shared";
import { api } from "./client";

/**
 * BL-022 / P8.b — "What we shipped yesterday" widget response shape.
 * Mirrors `YesterdaySummary` from server/src/services/yesterday-summary.ts.
 * Kept inline here (rather than imported from @founderos/shared) because
 * the server type lives in the server package and packages/shared/types
 * is outside this dispatch's allowed-paths boundary.
 */
export interface YesterdayOutcome {
  id: string;
  title: string;
  description: string;
}

export interface YesterdaySummaryResponse {
  outcomes: YesterdayOutcome[];
  source: "llm" | "fallback" | "empty";
  forDate: string;
  generatedAt: string;
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  yesterdaySummary: (companyId: string) =>
    api.get<YesterdaySummaryResponse>(`/companies/${companyId}/dashboard/yesterday`),
};
