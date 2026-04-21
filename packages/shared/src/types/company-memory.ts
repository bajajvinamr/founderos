export type MemoryKind = "weekly_summary" | "experiment_outcome" | "founder_note" | "milestone";
export type MemorySource = "auto" | "manual";

export type CompanyMemoryEntry = {
  id: string;
  companyId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  topic: string | null;
  occurredAt: Date;
  pinned: boolean;
  source: MemorySource;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCompanyMemoryInput = {
  kind?: MemoryKind;
  title: string;
  body: string;
  topic?: string | null;
  occurredAt?: Date;
  pinned?: boolean;
};

export type UpdateCompanyMemoryInput = {
  title?: string;
  body?: string;
  topic?: string | null;
  pinned?: boolean;
};
