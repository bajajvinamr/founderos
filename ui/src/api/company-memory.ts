import type { CompanyMemoryEntry, MemoryKind } from "@founderos/shared";
import { api } from "./client";

export type CreateMemoryBody = {
  kind?: MemoryKind;
  title: string;
  body: string;
  topic?: string | null;
  occurredAt?: string;
  pinned?: boolean;
};

export type UpdateMemoryBody = {
  title?: string;
  body?: string;
  topic?: string | null;
  pinned?: boolean;
};

export type ListMemoryParams = {
  kind?: MemoryKind;
  limit?: number;
  pinned?: boolean;
};

export const companyMemoryApi = {
  list: (companyId: string, params?: ListMemoryParams) => {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set("kind", params.kind);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.pinned !== undefined) qs.set("pinned", String(params.pinned));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    return api.get<CompanyMemoryEntry[]>(`/companies/${companyId}/memory${query}`);
  },

  create: (companyId: string, body: CreateMemoryBody) =>
    api.post<CompanyMemoryEntry>(`/companies/${companyId}/memory`, body),

  update: (companyId: string, entryId: string, body: UpdateMemoryBody) =>
    api.patch<CompanyMemoryEntry>(`/companies/${companyId}/memory/${entryId}`, body),

  remove: (companyId: string, entryId: string) =>
    api.delete<void>(`/companies/${companyId}/memory/${entryId}`),

  generateWeekly: (companyId: string, weekOf: string) =>
    api.post<CompanyMemoryEntry>(`/companies/${companyId}/memory/generate-weekly`, { weekOf }),
};
