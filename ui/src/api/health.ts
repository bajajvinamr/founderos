export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type HealthStatus = {
  status: "ok";
  version?: string;
};

/**
 * Bootstrap-state endpoint (task #139). Public route that returns the
 * fields the UI needs BEFORE the user is signed in: deployment mode,
 * whether auth is ready, and whether the instance has been bootstrapped
 * (any human admin yet?).
 *
 * These fields used to ride on /api/health ROOT but were split out so
 * the liveness probe response stops doubling as a recon surface.
 */
export type BootstrapState = {
  deploymentMode: "local_trusted" | "authenticated";
  authReady: boolean;
  bootstrapStatus: "ready" | "bootstrap_pending";
  bootstrapInviteActive: boolean;
};

/**
 * Authenticated diagnostics (task #139). Instance-admin gated; used by
 * ops dashboards. Devs running locally are local_implicit-admins so this
 * works without explicit auth in dev.
 */
export type Diagnostics = {
  deploymentExposure?: "private" | "public";
  features?: {
    companyDeletionEnabled?: boolean;
  };
  devServer?: DevServerHealthStatus;
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
};

export const bootstrapStateApi = {
  get: async (): Promise<BootstrapState> => {
    const res = await fetch("/api/health/bootstrap-state", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load bootstrap state (${res.status})`);
    }
    return res.json();
  },
};

export const diagnosticsApi = {
  get: async (): Promise<Diagnostics> => {
    const res = await fetch("/api/health/diagnostics", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load diagnostics (${res.status})`);
    }
    return res.json();
  },
};
