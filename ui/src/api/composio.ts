import { api } from "./client";

export type ComposioStatus = {
  enabled: boolean;
  configuredApps: string[];
};

export type ComposioConnection = {
  id: string;
  companyId: string;
  userId: string;
  appName: string;
  connectionId: string;
  status: "pending" | "active" | "failed" | "revoked" | "unknown";
  createdAt: string;
  updatedAt: string;
};

export type ComposioConnectResponse = {
  redirectUrl: string;
  connectionId: string;
};

export const composioApi = {
  status: () => api.get<ComposioStatus>("/composio/status"),
  connect: (companyId: string, appName: string) =>
    api.post<ComposioConnectResponse>(
      `/companies/${companyId}/composio/connect`,
      { appName },
    ),
  listConnections: (companyId: string, refresh = false) =>
    api.get<{ connections: ComposioConnection[] }>(
      `/companies/${companyId}/composio/connections${refresh ? "?refresh=1" : ""}`,
    ),
};
