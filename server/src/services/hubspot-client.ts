/**
 * Thin HubSpot CRM API client — native fetch, no SDK dependency.
 *
 * Read surface (CRM Pipeline console):
 *   - getDealPipelines()  — pipeline definitions including stage probabilities
 *   - getDeals()          — paginated deal objects (up to MAX_DEALS total)
 *
 * Write surface (Wave 18A — agent actions):
 *   - createContact()         — POST /crm/v3/objects/contacts
 *   - createNote()            — POST /crm/v3/objects/notes
 *   - associateNoteToContact()— PUT  /crm/v3/objects/notes/{noteId}/associations/contacts/{contactId}/note_to_contact
 *   - updateDealStage()       — PATCH /crm/v3/objects/deals/{dealId}
 *
 * All requests carry a 10-second timeout enforced via AbortController.
 * Pagination follows HubSpot's cursor pattern: paging.next.after.
 */

export class HubspotAuthError extends Error {
  constructor(message = "HubSpot authentication failed: invalid or expired access token") {
    super(message);
    this.name = "HubspotAuthError";
  }
}

export interface HubspotConfig {
  accessToken: string;
}

// ─── HubSpot response shapes ──────────────────────────────────────────────────

export interface HubspotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata: {
    probability?: string; // "0.5", "1.0", etc — string in the API
    isClosed?: string;
    isWon?: string;
  };
}

export interface HubspotPipeline {
  id: string;
  label: string;
  displayOrder: number;
  stages: HubspotPipelineStage[];
}

export interface HubspotDealProperties {
  dealname: string | null;
  amount: string | null; // numeric string e.g. "12000.00"
  dealstage: string | null; // stage ID
  closedate: string | null;
  pipeline: string | null;
  hubspot_owner_id: string | null;
}

export interface HubspotDeal {
  id: string;
  properties: HubspotDealProperties;
}

export interface HubspotContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  phone?: string;
}

export interface HubspotContact {
  id: string;
  properties: HubspotContactProperties & Record<string, string | null | undefined>;
}

export interface HubspotNote {
  id: string;
  properties: Record<string, string | null | undefined>;
}

export interface HubspotDealUpdateResponse {
  id: string;
  properties: Partial<HubspotDealProperties> & Record<string, string | null | undefined>;
}

export interface CreateContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
}

export interface CreateNoteInput {
  /** Note body (HubSpot expects `hs_note_body`). */
  body: string;
  /** Optional millis timestamp for `hs_timestamp`. Defaults to now. */
  timestampMs?: number;
}

export interface HubspotClient {
  getDealPipelines(): Promise<HubspotPipeline[]>;
  getDeals(pipelineId?: string): Promise<HubspotDeal[]>;
  createContact(input: CreateContactInput): Promise<HubspotContact>;
  createNote(input: CreateNoteInput): Promise<HubspotNote>;
  associateNoteToContact(noteId: string, contactId: string): Promise<void>;
  updateDealStage(dealId: string, stageId: string): Promise<HubspotDealUpdateResponse>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.hubapi.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_DEALS = 200;
const PAGE_SIZE = 100;

const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "closedate",
  "pipeline",
  "hubspot_owner_id",
].join(",");

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createHubspotClient(config: HubspotConfig): HubspotClient {
  const authHeaders = { Authorization: `Bearer ${config.accessToken}` };

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`HubSpot request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(
        `HubSpot network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new HubspotAuthError();
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HubSpot API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async function getDealPipelines(): Promise<HubspotPipeline[]> {
    const data = await apiFetch<{ results: HubspotPipeline[] }>(
      "/crm/v3/pipelines/deals",
    );
    return data.results;
  }

  async function getDeals(pipelineId?: string): Promise<HubspotDeal[]> {
    const deals: HubspotDeal[] = [];
    let after: string | undefined;

    while (deals.length < MAX_DEALS) {
      const remaining = MAX_DEALS - deals.length;
      const limit = Math.min(PAGE_SIZE, remaining);

      const params = new URLSearchParams({
        properties: DEAL_PROPERTIES,
        limit: String(limit),
      });
      if (after) {
        params.set("after", after);
      }
      if (pipelineId) {
        // HubSpot supports filtering by pipeline via filterGroups
        // but the simpler approach is to filter client-side after fetching,
        // since the deals endpoint doesn't have a direct pipeline query param
        // on the basic GET. We'll filter post-fetch.
      }

      const page = await apiFetch<{
        results: HubspotDeal[];
        paging?: { next?: { after?: string } };
      }>(`/crm/v3/objects/deals?${params.toString()}`);

      if (page.results.length === 0) break;
      deals.push(...page.results);

      const nextAfter = page.paging?.next?.after;
      if (!nextAfter) break;
      after = nextAfter;
    }

    // Filter by pipeline if requested
    if (pipelineId) {
      return deals.filter((d) => d.properties.pipeline === pipelineId);
    }

    return deals;
  }

  async function createContact(input: CreateContactInput): Promise<HubspotContact> {
    const properties: HubspotContactProperties = { email: input.email };
    if (input.firstName !== undefined) properties.firstname = input.firstName;
    if (input.lastName !== undefined) properties.lastname = input.lastName;
    if (input.company !== undefined) properties.company = input.company;
    if (input.phone !== undefined) properties.phone = input.phone;

    return apiFetch<HubspotContact>("/crm/v3/objects/contacts", {
      method: "POST",
      body: JSON.stringify({ properties }),
    });
  }

  async function createNote(input: CreateNoteInput): Promise<HubspotNote> {
    const properties: Record<string, string> = {
      hs_note_body: input.body,
      hs_timestamp: String(input.timestampMs ?? Date.now()),
    };

    return apiFetch<HubspotNote>("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({ properties }),
    });
  }

  async function associateNoteToContact(
    noteId: string,
    contactId: string,
  ): Promise<void> {
    // Default association type for note→contact is `note_to_contact`.
    // Using the v3 "default" association endpoint (no body required).
    await apiFetch<unknown>(
      `/crm/v3/objects/notes/${encodeURIComponent(noteId)}/associations/default/contacts/${encodeURIComponent(contactId)}`,
      { method: "PUT" },
    );
  }

  async function updateDealStage(
    dealId: string,
    stageId: string,
  ): Promise<HubspotDealUpdateResponse> {
    return apiFetch<HubspotDealUpdateResponse>(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: { dealstage: stageId } }),
      },
    );
  }

  return {
    getDealPipelines,
    getDeals,
    createContact,
    createNote,
    associateNoteToContact,
    updateDealStage,
  };
}
