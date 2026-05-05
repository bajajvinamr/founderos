import { api } from "./client";

export interface WorkspaceDepartmentRow {
  id: string;
  companyId: string;
  departmentId: string;
  enabled: boolean;
  autonomyLevel: number;
  createdAt: string;
  label: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  isCore: boolean;
}

export interface PatchDepartmentBody {
  enabled?: boolean;
  autonomyLevel?: number;
}

export const departmentsApi = {
  list: (companyId: string): Promise<WorkspaceDepartmentRow[]> =>
    api.get(`/companies/${companyId}/departments`),

  patch: (
    companyId: string,
    departmentId: string,
    body: PatchDepartmentBody,
  ): Promise<WorkspaceDepartmentRow> =>
    api.patch(`/companies/${companyId}/departments/${departmentId}`, body),
};
