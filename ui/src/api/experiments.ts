import { api } from "./client";

// Mirror of the DB-level enums (kept in sync manually with packages/db/src/schema/experiments.ts).
// Putting them here too means the UI doesn't have to import from @founderos/db.
export const EXPERIMENT_DEPARTMENTS = [
  "growth",
  "chief-of-staff",
  "content",
  "crm",
  "finance",
] as const;

export const EXPERIMENT_STATUSES = [
  "proposed",
  "running",
  "completed",
  "abandoned",
] as const;

export const EXPERIMENT_CHANNELS = [
  "linkedin",
  "paid_meta",
  "paid_google",
  "referral",
  "seo",
  "partnerships",
  "content",
] as const;

export type ExperimentDepartment = (typeof EXPERIMENT_DEPARTMENTS)[number];
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ExperimentChannel = (typeof EXPERIMENT_CHANNELS)[number];

/**
 * Wire-shape Experiment row. Note that bigint columns serialize as strings
 * over JSON (postgres-js returns bigint and JSON.stringify on bigint throws,
 * so the server casts to string). `iceScore` is computed server-side via
 * a generated column — clients never write it.
 */
export interface Experiment {
  id: string;
  companyId: string;
  department: ExperimentDepartment;
  hypothesis: string;
  channel: ExperimentChannel | null;
  expectedLiftPct: number | null;
  expectedCacCents: string | null;
  iceImpact: number;
  iceConfidence: number;
  iceEase: number;
  iceScore: number | null;
  status: ExperimentStatus;
  ownerAgentId: string | null;
  nextMilestone: string | null;
  actualLiftPct: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateExperimentBody {
  hypothesis: string;
  department?: ExperimentDepartment;
  channel?: ExperimentChannel | null;
  expectedLiftPct?: number | null;
  expectedCacCents?: string | number | null;
  iceImpact: number;
  iceConfidence: number;
  iceEase: number;
  status?: ExperimentStatus;
  ownerAgentId?: string | null;
  nextMilestone?: string | null;
}

export interface PatchExperimentBody {
  status?: ExperimentStatus;
  actualLiftPct?: number | null;
  completedAt?: string | null;
  nextMilestone?: string | null;
  ownerAgentId?: string | null;
}

export interface ListExperimentsQuery {
  status?: ExperimentStatus;
  channel?: ExperimentChannel;
}

function buildQueryString(query?: ListExperimentsQuery): string {
  if (!query) return "";
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.channel) params.set("channel", query.channel);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const experimentsApi = {
  list: (companyId: string, query?: ListExperimentsQuery): Promise<Experiment[]> =>
    api.get(`/companies/${companyId}/experiments${buildQueryString(query)}`),

  create: (companyId: string, body: CreateExperimentBody): Promise<Experiment> =>
    api.post(`/companies/${companyId}/experiments`, body),

  patch: (
    companyId: string,
    experimentId: string,
    body: PatchExperimentBody,
  ): Promise<Experiment> =>
    api.patch(`/companies/${companyId}/experiments/${experimentId}`, body),
};
