import type { CompanyMemoryEntry } from "@founderos/shared";
import { api } from "./client";

export type ExtractedInsight = {
  title: string;
  content: string;
  confidence: number;
  source_quote: string;
};

export type Conversation = {
  id: string;
  companyId: string;
  title: string;
  participants: string[];
  sourceKind: "transcript_paste" | "upload" | "slack_import";
  transcript: string;
  extractionStatus: "pending" | "complete" | "failed";
  extractedInsights: ExtractedInsight[] | null;
  createdAt: string;
  completedAt: string | null;
};

export type CreateConversationBody = {
  title: string;
  transcript: string;
  participants?: string[];
  sourceKind?: "transcript_paste" | "upload" | "slack_import";
};

export type PromoteInsightBody = {
  index: number;
  pinned?: boolean;
  topic?: string | null;
};

export const conversationsApi = {
  list: (companyId: string) =>
    api.get<Conversation[]>(`/companies/${companyId}/conversations`),

  detail: (companyId: string, conversationId: string) =>
    api.get<Conversation>(`/companies/${companyId}/conversations/${conversationId}`),

  create: (companyId: string, body: CreateConversationBody) =>
    api.post<Conversation>(`/companies/${companyId}/conversations`, body),

  promoteInsight: (companyId: string, conversationId: string, body: PromoteInsightBody) =>
    api.post<CompanyMemoryEntry>(
      `/companies/${companyId}/conversations/${conversationId}/promote-insight`,
      body,
    ),
};
