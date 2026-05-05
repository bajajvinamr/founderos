import { api } from "./client";

/**
 * Wire-shape for the GET /api/companies/:id/department-status response.
 * Mirrors `DepartmentStatusResponse` in
 * `server/src/routes/department-status.ts` (kept in sync manually so the UI
 * doesn't have to import from the server bundle).
 */
export const DEPARTMENT_IDS = [
  "chief-of-staff",
  "growth",
  "content",
  "crm",
  "finance",
] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export type DepartmentHealth = "green" | "yellow" | "red" | "grey";

export interface DepartmentRollup {
  health: DepartmentHealth;
  openInsights: number;
  pendingApprovals: number;
  stalledWorkflows: number;
  /** ISO 8601 timestamp string, or null if no agents in dept have ever ticked. */
  lastActivity: string | null;
  agentCount: number;
}

export type DepartmentStatusResponse = Record<DepartmentId, DepartmentRollup>;

export const departmentStatusApi = {
  get: (companyId: string): Promise<DepartmentStatusResponse> =>
    api.get(`/companies/${companyId}/department-status`),
};
