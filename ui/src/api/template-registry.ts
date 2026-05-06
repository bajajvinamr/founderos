import { api } from "./client";

/**
 * Template registry (S6.5) — read the catalogue of named PRD-flagship
 * workflow templates.
 */
export type NamedTemplateStatus = "live" | "v1_1_planned";

export interface NamedTemplate {
  id: string;
  displayName: string;
  department: string;
  status: NamedTemplateStatus;
  instantiateAs: string | null;
  triggerSummary: string;
  outcomeSummary: string;
  defaultAutonomy: 1 | 2 | 3 | 4;
}

export interface TemplateRegistryView {
  templates: NamedTemplate[];
  liveCount: number;
  plannedCount: number;
}

export const templateRegistryApi = {
  list: () => api.get<TemplateRegistryView>("/workflows/template-registry"),
};
