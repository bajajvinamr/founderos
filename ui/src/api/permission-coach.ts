import { api } from "./client";
import type { PermissionCoachRecommendation } from "@founderos/shared";

interface PermissionCoachResponse {
  recommendations: PermissionCoachRecommendation[];
}

export const permissionCoachApi = {
  async getRecommendations(
    companyId: string,
  ): Promise<PermissionCoachResponse> {
    return api.get(`/companies/${companyId}/permission-coach`);
  },

  async applyChange(
    companyId: string,
    agentId: string,
    targetLevel: string,
  ): Promise<{ success: boolean }> {
    return api.post(`/companies/${companyId}/permission-coach/apply`, {
      agentId,
      targetLevel,
    });
  },
};
