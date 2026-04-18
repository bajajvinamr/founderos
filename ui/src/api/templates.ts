import type {
  Company,
  CompanyTemplate,
  TemplateSummary,
  FounderOSAdapterType,
} from "@founderos/shared";
import { api } from "./client";

export type ProviderStrategy =
  | "mixed"
  | "anthropic_first"
  | "openai_first"
  | "google_first"
  | { kind: "override"; adapterType: FounderOSAdapterType; model: string };

export type SpawnFromTemplateRequest = {
  templateId: string;
  companyName?: string;
  providerStrategy?: ProviderStrategy;
  agentOverrides?: Record<string, { budgetUsd?: number }>;
};

export type ProviderAvailability = {
  anthropic: { api: boolean; cli: boolean };
  openai: { api: boolean; cli: boolean };
  google: { api: boolean; cli: boolean };
  anyConfigured: boolean;
};

export type ProviderCredentialReport = {
  family: "anthropic" | "openai" | "google";
  api: { configured: boolean; source: string };
  cli: { installed: boolean; authed: boolean; path: string | null; source: string };
};

export type StoredApiKeyRecord = {
  family: "anthropic" | "openai" | "google";
  executionMode: "api" | "cli_oauth";
  keyHint: string | null;
  updatedAt: string;
};

export type ProvidersResponse = {
  availability: ProviderAvailability;
  providers: ProviderCredentialReport[];
  storedKeys: StoredApiKeyRecord[];
};

export type SetProviderKeyRequest = {
  family: "anthropic" | "openai" | "google";
  executionMode?: "api" | "cli_oauth";
  value: string;
};

export type SpawnFromTemplateResponse = {
  companyId: string;
  templateId: string;
  agentsCreated: number;
  goalsCreated: number;
  projectsCreated: number;
  issuesCreated: number;
  company: Company;
};

export const templatesApi = {
  list: () => api.get<TemplateSummary[]>("/templates"),
  get: (id: string) => api.get<CompanyTemplate>(`/templates/${encodeURIComponent(id)}`),
  spawn: (req: SpawnFromTemplateRequest) =>
    api.post<SpawnFromTemplateResponse>("/templates/spawn", req),
  providers: () => api.get<ProvidersResponse>("/providers"),
  setProviderKey: (req: SetProviderKeyRequest) =>
    api.post<StoredApiKeyRecord>("/providers/keys", req),
  deleteProviderKey: (family: "anthropic" | "openai" | "google", executionMode: "api" | "cli_oauth" = "api") =>
    api.delete<void>(`/providers/keys/${family}/${executionMode}`),
};
