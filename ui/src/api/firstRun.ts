import { api } from "./client";

/**
 * S3.10 — Magic activation gate. Mirrors server/src/services/onboarding/first-run.ts.
 * Source of truth for these types is the server module; we duplicate the shape
 * here because @founderos/shared does not yet re-export it (cheap to keep in
 * sync — the server is the only writer).
 */
export type FirstRunStepId =
  | "backfill"
  | "agent-warmup"
  | "brief-generate"
  | "inbox-surface"
  | "complete";

export type FirstRunStepStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "error";

export interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  status: FirstRunStepStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface FirstRunProgress {
  companyId: string;
  status: "running" | "done" | "error";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: FirstRunStep[];
  completedSteps: number;
  totalSteps: number;
  dailyBriefId?: string;
  dailyBriefForDate?: string;
}

export const firstRunApi = {
  getProgress: (companyId: string) =>
    api.get<{ progress: FirstRunProgress | null }>(
      `/companies/${companyId}/first-run-progress`,
    ),
};
