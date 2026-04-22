import { api } from "./client";

export type DecisionOutcomeStatus =
  | "pending_followup"
  | "worked"
  | "did_not_work"
  | "unclear"
  | "dropped";

export interface DecisionOutcome {
  id: string;
  approvalId: string;
  companyId: string;
  outcomeStatus: DecisionOutcomeStatus;
  promptedAt: string;
  answeredAt: string | null;
  founderNote: string | null;
  metricDelta: string | null;
  memoryEntryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingOutcomesResponse {
  count: number;
  outcomes: DecisionOutcome[];
}

export interface RecordOutcomeBody {
  status: Exclude<DecisionOutcomeStatus, "pending_followup">;
  note?: string | null;
  metric?: string | null;
}

export interface PromoteOutcomeResponse {
  outcome: DecisionOutcome;
  memoryEntryId: string;
}

export const decisionOutcomesApi = {
  listPending: (companyId: string) =>
    api.get<PendingOutcomesResponse>(
      `/companies/${companyId}/decisions/pending-outcomes`,
    ),

  listForApproval: (companyId: string, approvalId: string) =>
    api.get<DecisionOutcome[]>(
      `/companies/${companyId}/decisions/${approvalId}/outcomes`,
    ),

  record: (companyId: string, approvalId: string, body: RecordOutcomeBody) =>
    api.post<DecisionOutcome>(
      `/companies/${companyId}/decisions/${approvalId}/outcomes`,
      body,
    ),

  promote: (companyId: string, approvalId: string, outcomeId: string) =>
    api.post<PromoteOutcomeResponse>(
      `/companies/${companyId}/decisions/${approvalId}/outcomes/${outcomeId}/promote`,
      {},
    ),
};
