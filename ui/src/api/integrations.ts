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
};
