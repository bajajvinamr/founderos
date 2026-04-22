import { api } from "./client";

export type WeeklyWrapHighlight = {
  type: "issue_shipped" | "decision_approved" | "activity" | "blocker";
  title: string;
  url?: string | null;
};

export type WeeklyWrapMetrics = {
  issuesShipped?: number;
  decisionsApproved?: number;
  activityCount?: number;
  openBlockers?: number;
  agentSpendCents?: number;
  [key: string]: unknown;
};

export type WeeklyWrap = {
  id: string;
  companyId: string;
  weekEndingAt: string;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
  metrics: WeeklyWrapMetrics;
  deliveredToSlackAt: string | null;
  deliveredToEmailAt: string | null;
  slackChannelId: string | null;
  createdAt: string;
};

export type GenerateWeeklyWrapResponse = {
  id: string;
  weekEndingAt: string;
  narrative: string;
  highlights: WeeklyWrapHighlight[];
  metrics: WeeklyWrapMetrics;
  reused: boolean;
};

export const weeklyWrapsApi = {
  list: (companyId: string) =>
    api.get<WeeklyWrap[]>(`/companies/${companyId}/weekly-wraps`),

  detail: (companyId: string, wrapId: string) =>
    api.get<WeeklyWrap>(`/companies/${companyId}/weekly-wraps/${wrapId}`),

  generateNow: (companyId: string) =>
    api.post<GenerateWeeklyWrapResponse>(
      `/companies/${companyId}/weekly-wraps/generate-now`,
      {},
    ),
};
