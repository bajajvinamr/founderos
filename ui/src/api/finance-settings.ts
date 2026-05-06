import type { FinanceSettings, UpsertFinanceSettings } from "@founderos/shared";
import { api } from "./client";

/**
 * Finance settings — singleton-per-company manual inputs (S5.9).
 *
 * Backend returns null when the founder hasn't filled in cash + burn yet;
 * the UI shows an "auto-prompt" empty state in that case (per S5.1 ticket
 * — the cockpit nudges if values are missing).
 */
export const financeSettingsApi = {
  get: (companyId: string) =>
    api.get<FinanceSettings | null>(
      `/companies/${companyId}/finance/settings`,
    ),

  upsert: (companyId: string, body: UpsertFinanceSettings) =>
    api.put<FinanceSettings>(
      `/companies/${companyId}/finance/settings`,
      body,
    ),
};
