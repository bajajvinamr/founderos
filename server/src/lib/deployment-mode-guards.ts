import type { DeploymentMode, DeploymentExposure } from "@founderos/shared";

export interface DeploymentModeSafetyInput {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  host: string;
  strictCompanyIsolation?: string | undefined;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

// Startup-time assertions for tenant-isolation safety. Fail loudly here so
// misconfigured deployments cannot silently bypass authorization at runtime.
export function assertDeploymentModeSafety(input: DeploymentModeSafetyInput): void {
  if (input.deploymentMode === "local_trusted") {
    if (!isLoopbackHost(input.host)) {
      throw new Error(
        `local_trusted mode requires loopback host binding (received: ${input.host}). ` +
          "Use authenticated mode for non-loopback deployments.",
      );
    }
    if (input.deploymentExposure !== "private") {
      throw new Error("local_trusted mode only supports private exposure");
    }
    return;
  }

  // Defense in depth: when not in local_trusted mode, require explicit
  // opt-in for company-isolation enforcement. The default-off behavior of
  // assertCompanyAccess is only safe when local_implicit actors are
  // structurally impossible (i.e. local_trusted mode). Any future
  // refactor that lets local_implicit leak into authenticated mode would
  // silently bypass tenant isolation; this assertion makes that scenario
  // refuse to start.
  if (input.strictCompanyIsolation !== "true") {
    throw new Error(
      `${input.deploymentMode} deployment mode requires FOUNDEROS_STRICT_COMPANY_ISOLATION=true. ` +
        "Default-off allows local_implicit actors to bypass tenant isolation. " +
        "Set FOUNDEROS_STRICT_COMPANY_ISOLATION=true in the environment.",
    );
  }
}
