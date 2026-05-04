/**
 * UI client for the runner-token management endpoints (BYO-104/105/106).
 *
 * Routes:
 *   POST   /api/companies/:id/runner-tokens         — issue (returns plaintext ONCE)
 *   DELETE /api/companies/:id/runner-tokens/:token  — revoke (idempotent)
 *   GET    /api/companies/:id/runner-tokens         — list (active + revoked)
 *   GET    /api/companies/:id/runner-status         — liveness (active only)
 */

import { api } from "./client";

export interface IssuedRunnerToken {
  tokenId: string;
  /** Plaintext value, fos_<32 chars>. SHOWN ONCE. */
  token: string;
  label: string;
  createdAt: string;
}

export interface RunnerTokenSummary {
  tokenId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface RunnerTokenWithRevoke extends RunnerTokenSummary {
  revokedAt: string | null;
}

export const runnerApi = {
  issue: (companyId: string, label?: string) =>
    api.post<IssuedRunnerToken>(`/companies/${companyId}/runner-tokens`, { label: label ?? "" }),

  revoke: (companyId: string, tokenId: string) =>
    api.delete<void>(`/companies/${companyId}/runner-tokens/${tokenId}`),

  list: (companyId: string) =>
    api.get<{ tokens: RunnerTokenWithRevoke[] }>(`/companies/${companyId}/runner-tokens`),

  status: (companyId: string) =>
    api.get<{ tokens: RunnerTokenSummary[] }>(`/companies/${companyId}/runner-status`),
};
