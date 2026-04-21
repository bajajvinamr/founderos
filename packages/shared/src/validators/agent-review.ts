import { z } from "zod";

export const agentReviewRecommendationSchema = z.enum(["keep", "rebrief", "let_go", "promote"]);

export const generateAgentReviewSchema = z.object({
  monthOf: z.string().regex(/^\d{4}-\d{2}-01$/, "monthOf must be YYYY-MM-01"),
});

export const createManualAgentReviewSchema = z.object({
  summaryMarkdown: z.string().min(1),
  recommendation: agentReviewRecommendationSchema,
  rationale: z.string().min(1),
  monthOf: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, "monthOf must be YYYY-MM-01")
    .optional(),
});

export type GenerateAgentReview = z.infer<typeof generateAgentReviewSchema>;
export type CreateManualAgentReview = z.infer<typeof createManualAgentReviewSchema>;
