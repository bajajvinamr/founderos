import { z } from "zod";
import { INTEGRATION_KINDS, INTEGRATION_STATUSES } from "../constants.js";

export const createIntegrationSchema = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  apiKey: z.string().min(1, "API key cannot be empty"),
  config: z.record(z.unknown()).optional(),
});

export type CreateIntegration = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z.object({
  status: z.enum(INTEGRATION_STATUSES).optional(),
  lastError: z.string().nullable().optional(),
});

export type UpdateIntegration = z.infer<typeof updateIntegrationSchema>;
