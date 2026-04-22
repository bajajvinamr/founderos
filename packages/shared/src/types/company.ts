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
  /**
   * Free-form markdown answering "what are we building and why."
   * Injected into every teammate's standing prompt on every shift so the
   * whole team operates with the founder's mission in context. Editable
   * from CompanySettings. Default empty; nudge shown on Dashboard when
   * unset so founders are gently pushed to fill it in.
   */
  charter?: string;
  /**
   * Slack channel ID to post the Weekly Wrap into, when the CoS agent has
   * sufficient permission and a Slack integration is connected. Configured
   * from Company Settings → "Slack post target".
   */
  weeklyWrapSlackChannelId?: string;
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
