import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Persistent record of an operator's telemetry consent decision. The
 * landing page promises "no telemetry unless you flip it on" — so the
 * default state is `decided: false`, which means the onboarding consent
 * step has not been shown yet AND no events leave the host. Once the
 * operator answers (yes or no), `decided` flips to true and `enabled`
 * carries the answer.
 *
 * Server-side, `enabled` is the only field that gates the ingest client;
 * `decided` is metadata for the UI so it can suppress the consent prompt
 * on subsequent visits. Both default to false (council 2026-05-05 P1).
 */
export interface TelemetryConsent {
  /** True iff operator has explicitly opted in. Default false. */
  enabled: boolean;
  /** True once the operator has answered (yes or no). Default false. */
  decided: boolean;
  /** ISO 8601 timestamp of the most recent decision; null until decided. */
  decidedAt: string | null;
}

export const DEFAULT_TELEMETRY_CONSENT: TelemetryConsent = {
  enabled: false,
  decided: false,
  decidedAt: null,
};

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  telemetryConsent: TelemetryConsent;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
