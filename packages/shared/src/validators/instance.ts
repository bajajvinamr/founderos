import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_TELEMETRY_CONSENT,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

/**
 * Telemetry consent validator. Default consent is OFF (council 2026-05-05
 * P1 fix); the landing page promises "no telemetry unless you flip it on",
 * so any time a row materializes without an explicit `enabled: true`, we
 * MUST fall back to disabled. Re-flipping the default to true is a
 * trust-contract regression — see config-telemetry-defaults.test.ts.
 */
export const telemetryConsentSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_TELEMETRY_CONSENT.enabled),
    decided: z.boolean().default(DEFAULT_TELEMETRY_CONSENT.decided),
    decidedAt: z.string().datetime().nullable().default(DEFAULT_TELEMETRY_CONSENT.decidedAt),
  })
  .strict()
  .default(DEFAULT_TELEMETRY_CONSENT);

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  telemetryConsent: telemetryConsentSchema.default(DEFAULT_TELEMETRY_CONSENT),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
