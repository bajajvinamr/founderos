import type { CompanyStatus, PauseReason } from "../constants.js";

/**
 * FounderOS business metrics for a company. Surfaces as the Dashboard
 * "Company Pulse" widget. All money is in integer cents.
 */
export interface CompanyMetrics {
  stage?: string;
  tagline?: string;
  fundingRaisedCents?: number;
  mrrCents?: number;
  arrCents?: number;
  gmvMonthlyCents?: number;
  pipelineCents?: number;
  pipelineCount?: number;
  customersSigned?: number;
  monthlyBurnCents?: number;
  runwayMonths?: number;
  keyAccounts?: string[];
  nextMilestoneLabel?: string;
  mauCount?: number;
  deltas?: Record<string, { dir: "up" | "down" | "flat"; text: string }>;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  metrics: CompanyMetrics;
  createdAt: Date;
  updatedAt: Date;
}
