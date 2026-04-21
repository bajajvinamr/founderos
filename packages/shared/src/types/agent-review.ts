export type AgentReviewRecommendation = "keep" | "rebrief" | "let_go" | "promote";
export type AgentReviewSource = "auto" | "manual";

export interface AgentReview {
  id: string;
  agentId: string;
  companyId: string;
  monthOf: string; // ISO date string YYYY-MM-DD (first of month)
  shiftsRun: number;
  issuesClosed: number;
  costCents: number;
  blockedIncidents: number;
  summaryMarkdown: string;
  recommendation: AgentReviewRecommendation;
  rationale: string;
  source: AgentReviewSource;
  generatedAt: Date;
}
