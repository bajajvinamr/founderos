import { z } from "zod";

/**
 * Finance scenario modeling (S5.4) — natural-language "what-if" endpoint.
 *
 * The founder types a question like "what happens if I reduce free credits
 * by 70%?" and the server orchestrates Claude with the existing finance
 * services as tools (cockpit, pricing-simulator, churn-forecast, runway,
 * cash-plan). Claude decides which tools to call, in what order, then
 * synthesizes a structured answer with reasoning.
 *
 * Bounds:
 * - question: 8..1000 chars (non-trivial input, not a runaway prompt)
 * - maxSteps: 1..8 (caps tool-loop iterations; default 6 is enough for
 *   a multi-tool scenario without runaway cost)
 */

export const financeScenarioInputSchema = z.object({
  question: z.string().min(8).max(1000),
  maxSteps: z.number().int().min(1).max(8).default(6),
});
export type FinanceScenarioInput = z.infer<typeof financeScenarioInputSchema>;
