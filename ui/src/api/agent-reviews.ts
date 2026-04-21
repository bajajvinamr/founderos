import type { AgentReview, AgentReviewRecommendation } from "@founderos/shared";
import { api } from "./client";

export type ListAgentReviewsParams = {
  agentId?: string;
  limit?: number;
};

export type GenerateReviewBody = {
  monthOf: string; // YYYY-MM-01
};

export type CreateManualReviewBody = {
  summaryMarkdown: string;
  recommendation: AgentReviewRecommendation;
  rationale: string;
  monthOf?: string;
};

export const agentReviewsApi = {
  list: (companyId: string, params?: ListAgentReviewsParams) => {
    const qs = new URLSearchParams();
    if (params?.agentId) qs.set("agentId", params.agentId);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return api.get<AgentReview[]>(`/companies/${companyId}/agent-reviews${query}`);
  },

  getLatest: (companyId: string, agentId: string) =>
    api.get<AgentReview>(`/companies/${companyId}/agents/${agentId}/reviews/latest`),

  generate: (companyId: string, agentId: string, body: GenerateReviewBody) =>
    api.post<AgentReview>(`/companies/${companyId}/agents/${agentId}/reviews/generate`, body),

  createManual: (companyId: string, agentId: string, body: CreateManualReviewBody) =>
    api.post<AgentReview>(`/companies/${companyId}/agents/${agentId}/reviews`, body),
};
