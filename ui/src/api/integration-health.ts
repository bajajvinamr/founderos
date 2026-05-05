import { api } from "./client";

export type ConnectorHealthStatus =
  | "connected"
  | "syncing"
  | "failed"
  | "never_connected";

export type ConnectorHealth = {
  source: string;
  status: ConnectorHealthStatus;
  lastSync: string | null;
  lastError: string | null;
  retryAvailable: boolean;
};

export type KpiFreshness = {
  mrr: { sourceLastSync: string | null } | null;
  arr: { sourceLastSync: string | null } | null;
  signups: { sourceLastSync: string | null } | null;
  pipeline: { sourceLastSync: string | null } | null;
  burn: { sourceLastSync: string | null } | null;
  runway: { sourceLastSync: string | null } | null;
};

export const integrationHealthApi = {
  listHealth: (companyId: string) =>
    api.get<ConnectorHealth[]>(`/integrations/health?companyId=${encodeURIComponent(companyId)}`),

  kpiFreshness: (companyId: string) =>
    api.get<KpiFreshness>(`/companies/${companyId}/kpi-freshness`),
};
