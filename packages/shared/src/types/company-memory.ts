export type MemoryKind = "weekly_summary" | "experiment_outcome" | "founder_note" | "milestone";
export type MemorySource = "auto" | "manual";

/**
 * S6.4 — agent-recall semantic role. Closed set; mirrored by the CHECK
 * constraint in migration 0099 and by `COMPANY_MEMORY_CATEGORIES` in
 * `@founderos/db`. Add new values via migration + that const + this union,
 * all together.
 */
export type MemoryCategory = "decision" | "pattern" | "context" | "outcome";

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
  /** S6.4 — semantic category for agent recall. Null when uncategorized. */
  category: MemoryCategory | null;
  /** S6.4 — TTL. Null = no expiry (default). */
  expiresAt: Date | null;
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
  category?: MemoryCategory | null;
  expiresAt?: Date | null;
};

export type UpdateCompanyMemoryInput = {
  title?: string;
  body?: string;
  topic?: string | null;
  pinned?: boolean;
  category?: MemoryCategory | null;
  expiresAt?: Date | null;
};
