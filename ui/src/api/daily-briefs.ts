import { api } from "./client";

// Wire shape — mirrors packages/db/src/schema/daily_briefs.ts
// DailyBriefPayload. Kept here so the UI doesn't need to import from
// @founderos/db (same pattern as ui/src/api/experiments.ts).

export type DailyBriefKpiMovement = {
  metric: string;
  from: string;
  to: string;
  delta: string;
  commentary: string;
};

export type DailyBriefAnomaly = {
  title: string;
  insightId: string;
};

export type DailyBriefBlocker = {
  title: string;
  resolutionAction: string;
};

export type DailyBriefOpportunity = {
  title: string;
  expectedImpact: string;
  insightId: string;
};

export type DailyBriefTopAction = {
  action: string;
  rationale: string;
  approvalId?: string;
};

export type DailyBriefPayload = {
  headline: string;
  kpiMovements: DailyBriefKpiMovement[];
  anomalies: DailyBriefAnomaly[];
  blockers: DailyBriefBlocker[];
  opportunities: DailyBriefOpportunity[];
  topThreeActions: DailyBriefTopAction[];
};

export type DailyBrief = {
  id: string;
  companyId: string;
  /** ISO yyyy-mm-dd. */
  forDate: string;
  payload: DailyBriefPayload;
  generatedAt: string;
  emailSentAt: string | null;
};

export type DailyBriefsListResponse = {
  briefs: DailyBrief[];
  meta: { limit: number; offset: number; count: number };
};

export type GenerateDailyBriefResponse = DailyBrief & {
  reused: boolean;
  source: "llm" | "fallback" | "welcome";
  fallbackReason?: string;
};

/**
 * Trimmed wire shape returned by `GET /companies/:id/daily-briefs/latest`.
 * Intentionally narrower than `DailyBrief` — the /today UI only needs the
 * date stamp + payload, not generation metadata. Use `list()` or `detail()`
 * when consumers need `generatedAt`, `emailSentAt`, or `id`.
 */
export type LatestDailyBriefResponse = {
  briefDate: string;
  payload: DailyBriefPayload;
};

export const dailyBriefsApi = {
  /** List recent briefs newest-first (paginated). */
  list: (companyId: string, limit = 30, offset = 0): Promise<DailyBriefsListResponse> =>
    api.get(
      `/companies/${companyId}/daily-briefs?limit=${limit}&offset=${offset}`,
    ),

  /**
   * Fetch the most-recent brief for the company. Throws ApiError(404) when
   * no brief exists — callers should handle that as the empty state, not an
   * error condition.
   */
  latest: (companyId: string): Promise<LatestDailyBriefResponse> =>
    api.get(`/companies/${companyId}/daily-briefs/latest`),

  /** Fetch the single brief for an ISO yyyy-mm-dd date. 404 if absent. */
  forDate: (companyId: string, forDate: string): Promise<DailyBrief> =>
    api.get(`/companies/${companyId}/daily-briefs?forDate=${encodeURIComponent(forDate)}`),

  /** Fetch a brief by id. */
  detail: (companyId: string, briefId: string): Promise<DailyBrief> =>
    api.get(`/companies/${companyId}/daily-briefs/${briefId}`),

  /**
   * Trigger generation for today (or a specific forDate). Idempotent:
   * if a brief already exists for the date, returns it with reused=true.
   */
  generateNow: (
    companyId: string,
    body?: { forDate?: string; timezone?: string },
  ): Promise<GenerateDailyBriefResponse> =>
    api.post(
      `/companies/${companyId}/daily-briefs/generate-now`,
      body ?? {},
    ),
};
