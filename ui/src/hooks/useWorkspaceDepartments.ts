import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { departmentsApi, type PatchDepartmentBody, type WorkspaceDepartmentRow } from "../api/departments";
import { queryKeys } from "../lib/queryKeys";

/**
 * Fetches the workspace-scoped department list for a company.
 *
 * The synchronous DEPARTMENTS export in departments.ts remains as a fallback
 * for tests, SSR, and callers that don't need per-workspace overrides.
 * Use this hook when you need live DB state (enabled flags, autonomy levels).
 */
export function useWorkspaceDepartments(companyId: string | null | undefined) {
  return useQuery<WorkspaceDepartmentRow[]>({
    queryKey: companyId ? queryKeys.departments.list(companyId) : ["departments", "__disabled__"],
    queryFn: () => departmentsApi.list(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
  });
}

export function useToggleDepartment(companyId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      departmentId,
      body,
    }: {
      departmentId: string;
      body: PatchDepartmentBody;
    }) => departmentsApi.patch(companyId, departmentId, body),

    onSuccess: (updated) => {
      queryClient.setQueryData<WorkspaceDepartmentRow[]>(
        queryKeys.departments.list(companyId),
        (prev) =>
          prev
            ? prev.map((d) => (d.departmentId === updated.departmentId ? updated : d))
            : [updated],
      );
    },
  });
}
