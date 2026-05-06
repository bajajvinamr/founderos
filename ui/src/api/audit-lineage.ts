import { api } from "./client";

/**
 * Audit lineage (S6.3) — read-only expansion of a single activity_log
 * row's lineage_refs into the upstream entities that justified it.
 */
export interface LineageWorkflow {
  id: string;
  name: string;
  template: string;
  status: string;
  autonomyLevel: number;
}

export interface LineageInsight {
  id: string;
  department: string;
  kind: string;
  title: string;
  confidence: number;
  status: string;
  createdAt: string;
}

export interface LineageApproval {
  id: string;
  type: string;
  status: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface LineageEvent {
  id: string;
  source: string;
  eventName: string;
  occurredAt: string;
}

export interface LineageExpansion {
  log: {
    id: string;
    companyId: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    workflowId: string | null;
    runId: string | null;
    createdAt: string;
    details: Record<string, unknown> | null;
    lineageRefs: Record<string, unknown> | null;
  };
  workflow: LineageWorkflow | null;
  workflowRun: { id: string; status: string; createdAt: string } | null;
  insights: LineageInsight[];
  approvals: LineageApproval[];
  events: LineageEvent[];
}

export const auditLineageApi = {
  expand: (logId: string) =>
    api.get<LineageExpansion>(`/audit/${logId}/lineage`),
};
