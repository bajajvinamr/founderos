import { api } from "./client";

export interface IntegrationDataResponse<T = Record<string, unknown>> {
  kind: string;
  payload: T;
  fetchedAt: string;
}

// ─── HubSpot shapes ───────────────────────────────────────────────────────────

export interface HubspotDealCard {
  id: string;
  name: string;
  amount: number; // dollars
  stageId: string;
  stageLabel: string;
  lastTouchAt: string | null;
  ownerName: string;
}

export interface HubspotPipelineStageData {
  id: string;
  label: string;
  count: number;
  totalCents: number;
  weightedCents: number;
  deals: HubspotDealCard[];
}

export interface HubspotPipelinePayload {
  pipelineName: string;
  totalDeals: number;
  stages: HubspotPipelineStageData[];
}

// ─── PostHog shapes ───────────────────────────────────────────────────────────

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

  getHubspotPipeline: (companyId: string) =>
    integrationDataApi.get<HubspotPipelinePayload>(companyId, "hubspot.pipeline"),

  sync: (companyId: string, integrationId: string) =>
    api.post<{ ok: boolean; synced?: string[]; error?: string }>(
      `/companies/${companyId}/integrations/${integrationId}/sync`,
      {},
    ),
};
