import { api } from "./client";

/**
 * Permissions matrix (S6.1) — read-only aggregator over autonomy state.
 *
 * Mirrors `PermissionsMatrix` from
 * server/src/services/permissions-matrix.ts. Promote to @founderos/shared
 * when a second consumer (CLI, plugin) needs the type.
 */
export type AutonomySource = "inherited" | "override";

export interface PermissionsMatrixWorkflow {
  id: string;
  name: string;
  template: string;
  status: string;
  autonomy: number;
  source: AutonomySource;
}

export interface PermissionsMatrixDepartment {
  id: string;
  label: string;
  icon: string | null;
  deptAutonomy: number;
  workflows: PermissionsMatrixWorkflow[];
}

export interface PermissionsMatrix {
  companyId: string;
  autonomousMasterSwitch: boolean;
  departments: PermissionsMatrixDepartment[];
}

export const permissionsApi = {
  matrix: (companyId: string) =>
    api.get<PermissionsMatrix>(
      `/companies/${companyId}/permissions-matrix`,
    ),
};

/** UI-side label for each autonomy level (1..4). */
export const AUTONOMY_LABELS: Record<number, string> = {
  1: "Observe",
  2: "Draft",
  3: "Approval",
  4: "Autonomous",
};

/** Short description shown under each label in the matrix UI. */
export const AUTONOMY_DESCRIPTIONS: Record<number, string> = {
  1: "Agent analyses; never acts",
  2: "Agent drafts; founder reviews",
  3: "Agent queues; human approves each",
  4: "Agent executes immediately",
};
