export interface PermissionCoachRecommendation {
  agentId: string;
  agentName: string;
  currentLevel: string;
  approvedCount: number;
  rejectedCount: number;
  rate: number;
  recommendation: "upgrade" | "downgrade" | "hold";
  targetLevel?: string;
}
