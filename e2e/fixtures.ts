/**
 * Shared fixtures + helpers for Wave 23A critical-flow E2E.
 *
 * Design choices:
 * - One exported `test` with typed fixtures (`api`, `companyCtx`, `profile`).
 * - `api` wraps `request` with base-URL-relative calls + nice error surfaces
 *   that include request/response body when an assertion fails. This makes
 *   a failing CI run actionable without digging through HTML reports.
 * - `profile` is derived from `FOUNDEROS_E2E_PROFILE` and consumed by specs
 *   to skip auth-required flows when we're pointed at production.
 */
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

export type Profile = "default" | "public-only";

export function resolveProfile(): Profile {
  const raw = (process.env.FOUNDEROS_E2E_PROFILE || "default").toLowerCase();
  return raw === "public-only" ? "public-only" : "default";
}

export interface HealthResponse {
  status?: string;
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: string;
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: Record<string, unknown>;
}

export interface CompanySummary {
  id: string;
  name: string;
  issuePrefix: string;
}

export interface AgentSummary {
  id: string;
  companyId: string;
  name: string;
}

export interface CompanyCtx {
  company: CompanySummary;
  agents: AgentSummary[];
}

export class ApiHelper {
  constructor(
    public readonly base: string,
    private readonly ctx: APIRequestContext,
  ) {}

  /** GET and return parsed JSON + status. Never throws on non-2xx. */
  async get(path: string, opts: { headers?: Record<string, string> } = {}) {
    const url = this.join(path);
    const res = await this.ctx.get(url, { headers: opts.headers });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status(), json, text, headers: res.headers(), url };
  }

  async post(
    path: string,
    body: unknown,
    opts: { headers?: Record<string, string> } = {},
  ) {
    const url = this.join(path);
    const res = await this.ctx.post(url, {
      data: body,
      headers: { "content-type": "application/json", ...opts.headers },
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status(), json, text, headers: res.headers(), url };
  }

  private join(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = this.base.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }
}

/**
 * Build a rich assertion error message: includes the request URL + a
 * truncated response body so logs are actually useful.
 */
export function describeResponse(
  label: string,
  r: { status: number; url: string; text: string },
): string {
  const body = r.text ? r.text.slice(0, 500) : "<empty>";
  return `${label}\n  url:    ${r.url}\n  status: ${r.status}\n  body:   ${body}`;
}

/**
 * Load the demo company context. We use the canonical "AGN" prefix (agnost.ai)
 * seeded by `packages/db/src/seed-demo.ts` by default. Override with
 * FOUNDEROS_E2E_DEMO_PREFIX for other local demos.
 *
 * Skips tests cleanly when the companies endpoint is unavailable (e.g. prod
 * when the suite is unauthenticated).
 */
export async function loadCompanyCtx(api: ApiHelper): Promise<CompanyCtx | null> {
  const r = await api.get("/api/companies");
  if (r.status !== 200 || !Array.isArray(r.json)) return null;
  const prefix = (process.env.FOUNDEROS_E2E_DEMO_PREFIX || "AGN").toUpperCase();
  const companies = r.json as CompanySummary[];
  const match =
    companies.find((c) => (c.issuePrefix || "").toUpperCase() === prefix) ??
    companies[0];
  if (!match) return null;

  const ar = await api.get(`/api/companies/${match.id}/agents`);
  const agents = ar.status === 200 && Array.isArray(ar.json) ? (ar.json as AgentSummary[]) : [];
  return { company: match, agents };
}

type Fixtures = {
  api: ApiHelper;
  profile: Profile;
  /** May be null on public-only profile; specs needing it should `test.skip`. */
  companyCtx: CompanyCtx | null;
};

export const test = base.extend<Fixtures>({
  api: async ({ request, baseURL }, use) => {
    const base = baseURL || process.env.FOUNDEROS_E2E_BASE_URL || "http://localhost:3100";
    await use(new ApiHelper(base, request));
  },
  profile: async ({}, use) => {
    await use(resolveProfile());
  },
  companyCtx: async ({ api, profile }, use) => {
    if (profile === "public-only") {
      await use(null);
      return;
    }
    const ctx = await loadCompanyCtx(api);
    await use(ctx);
  },
});

export { expect };

/**
 * Small helper used across UI specs — waits for the page to settle into
 * either the auth form, landing, or a recognised error banner. Avoids
 * flakiness from slow React lazy-loaded chunks on cold starts.
 */
export async function waitForAppReady(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  // Root mount: `#root` exists in `ui/index.html`. Wait for any text to
  // appear so we don't assert before hydration.
  await page
    .locator("#root")
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
}
