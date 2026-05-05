import type { Integration } from "@founderos/shared";
import type { IntegrationKind } from "@founderos/shared";
import { api } from "./client";

export type CreateIntegrationBody = {
  kind: IntegrationKind;
  apiKey: string;
  config?: Record<string, unknown>;
};

export type SlackChannelSummary = {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
};

/**
 * S2.10: Mock shape for the integration health endpoint.
 *
 * TODO(S2.7): Implement `GET /companies/:companyId/integrations/health` on the
 * server side. The shape below is the contract S2.10 UI consumes — keep it in
 * sync. Until then, the UI falls back to the existing `list()` endpoint and
 * derives status from per-integration rows.
 */
export type IntegrationHealthResponse = {
  sources: Record<
    IntegrationKind,
    {
      status: "connected" | "error" | "never_connected";
      lastSync?: string;
      errorMessage?: string;
    }
  >;
};

export const integrationsApi = {
  list: (companyId: string) =>
    api.get<Integration[]>(`/companies/${companyId}/integrations`),

  create: (companyId: string, body: CreateIntegrationBody) =>
    api.post<Integration>(`/companies/${companyId}/integrations`, body),

  remove: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/integrations/${id}`),

  test: (companyId: string, id: string) =>
    api.post<{ ok: boolean; lastChecked: string }>(
      `/companies/${companyId}/integrations/${id}/test`,
      {},
    ),

  listSlackChannels: (companyId: string) =>
    api.get<{ channels: SlackChannelSummary[] }>(
      `/companies/${companyId}/integrations/slack/channels`,
    ),

  /**
   * Fetch aggregated source health (status + last sync per source).
   *
   * TODO(S2.7): Backed by `GET /companies/:companyId/integrations/health`
   * which does not yet exist. Until S2.7 lands, callers should prefer
   * deriving health from `list()` + the source's own `lastSyncAt` column.
   */
  health: (companyId: string) =>
    api.get<IntegrationHealthResponse>(
      `/companies/${companyId}/integrations/health`,
    ),
};
