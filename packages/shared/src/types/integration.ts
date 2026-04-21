import type { IntegrationKind, IntegrationStatus } from "../constants.js";

export type { IntegrationKind, IntegrationStatus };

export type Integration = {
  id: string;
  companyId: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  /** Last 4 chars of the API key — never the full value. */
  keyHint: string | null;
  /** Opaque per-integration config (workspace IDs, account IDs, etc.). */
  config: Record<string, unknown> | null;
  lastError: string | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateIntegrationInput = {
  kind: IntegrationKind;
  apiKey: string;
  config?: Record<string, unknown>;
};

export type UpdateIntegrationInput = {
  status?: IntegrationStatus;
  lastError?: string | null;
};
