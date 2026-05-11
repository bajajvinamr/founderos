/**
 * @fileoverview Frontend API client for the AI Connections page (BL-016 / P5.a).
 *
 * This is a presentation-layer client that composes existing adapter/company
 * APIs into the shape the AI Connections page consumes. Per dispatch scope,
 * we DO NOT introduce new server routes here — server-side wiring for
 * per-department adapter assignments and explicit fallback ordering lands
 * in BL-017 (P5.b). For now, the helpers below return shapes that the page
 * can render as "scaffold + TODO" sections.
 */

import { adaptersApi, type AdapterInfo } from "./adapters";

/**
 * Status surfaced in the Connected list. Mirrors the language used in
 * Integrations.tsx's StatusPill (connected / error / disconnected) but
 * specialised for adapters where "validation needed" is the disabled state.
 */
export type AiConnectionStatus = "connected" | "validation_needed" | "disconnected";

export interface AiConnectionRow {
  type: string;
  label: string;
  source: AdapterInfo["source"];
  status: AiConnectionStatus;
  modelsCount: number;
  version?: string;
}

/** Map an AdapterInfo to the row shape consumed by the AI Connections list. */
export function toConnectionRow(adapter: AdapterInfo): AiConnectionRow {
  const status: AiConnectionStatus = adapter.disabled
    ? "validation_needed"
    : adapter.loaded
      ? "connected"
      : "disconnected";

  return {
    type: adapter.type,
    label: adapter.label,
    source: adapter.source,
    status,
    modelsCount: adapter.modelsCount,
    version: adapter.version,
  };
}

/**
 * Shape of the per-department usage row. Server-side endpoint does not
 * exist as of P5.a — BL-017 / P5.b will wire it. For now, the page renders
 * a placeholder TODO instead of inventing a server endpoint.
 */
export interface DepartmentAdapterAssignment {
  departmentId: string;
  departmentLabel: string;
  adapterType: string | null;
}

/**
 * Fallback-order entry. v1 is local-only ordering; persistence + the
 * "default for new work" wiring lands in BL-017 (P5.b). The page keeps
 * the array in component state until then.
 */
export interface FallbackOrderEntry {
  adapterType: string;
  label: string;
}

export const aiConnectionsApi = {
  /**
   * Return the company's adapters mapped into AiConnectionRow shape.
   * Today this is just `/adapters` + presentation mapping; a follow-up
   * (P5.b) will scope by company once the server endpoint exists.
   */
  list: async (): Promise<AiConnectionRow[]> => {
    const adapters = await adaptersApi.list();
    return adapters.map(toConnectionRow);
  },
};
