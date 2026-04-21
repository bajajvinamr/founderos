import { api } from "./client";

export interface IntegrationDataResponse<T = Record<string, unknown>> {
  kind: string;
  payload: T;
  fetchedAt: string;
}

export interface PostHogFunnelPayload {
  pageviews: number;
  signups: number;
  activations: number;
  trials: number;
  paid: number;
  periodDays: number;
}

export interface PostHogChannelEntry {
  source: string;
  count: number;
}

export interface PostHogChannelsPayload {
  channels: PostHogChannelEntry[];
  periodDays: number;
}

export const integrationDataApi = {
  get: <T = Record<string, unknown>>(companyId: string, kind: string) =>
    api.get<IntegrationDataResponse<T>>(
      `/companies/${companyId}/integration-data?kind=${encodeURIComponent(kind)}`,
    ),

  getFunnel: (companyId: string) =>
    integrationDataApi.get<PostHogFunnelPayload>(companyId, "posthog.funnel"),

  getChannels: (companyId: string) =>
    integrationDataApi.get<PostHogChannelsPayload>(
      companyId,
      "posthog.channels.utm_source",
    ),

  sync: (companyId: string, integrationId: string) =>
    api.post<{ ok: boolean; synced?: string[]; error?: string }>(
      `/companies/${companyId}/integrations/${integrationId}/sync`,
      {},
    ),
};
