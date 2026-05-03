/**
 * Route table for the route-load smoke spec.
 *
 * Mirrors `ui/src/App.tsx` — every route declared in <Routes> appears here,
 * grouped by access tier. The smoke spec walks each entry and asserts the
 * page renders without triggering an error boundary or a JS error.
 *
 * Maintenance contract:
 *   - Add a row when adding a Route to App.tsx.
 *   - For routes with params, declare the param name + how to derive a value
 *     from the seeded company context (loaded once per spec run).
 *   - If a route is intentionally unsmokable (external token, plugin shell,
 *     interactive flow), set `skip: true` with a one-line reason.
 */

export interface RouteParam {
  /** Name of the URL parameter, e.g. "agentId". */
  name: string;
  /** How to derive a value at runtime. */
  source: "company" | "agent" | "project" | "issue" | "goal" | "approval" | "routine" | "static";
  /** Static value when source = "static". */
  value?: string;
}

export interface RouteEntry {
  /** Path template, with `:paramName` placeholders. */
  path: string;
  /** Optional params to substitute. */
  params?: RouteParam[];
  /** Skip this route in the smoke pass; reason required. */
  skip?: { reason: string };
  /** A route is "company-prefixed" if its template starts with `:companyPrefix`. */
  companyPrefixed?: boolean;
  /** Whether this route is expected to redirect to another route. Smoke just
   *  cares the redirect resolves cleanly without crashing. */
  expectsRedirect?: boolean;
}

/**
 * Public routes (no auth, no company context). All should render even when
 * the suite has no session.
 */
export const PUBLIC_ROUTES: RouteEntry[] = [
  { path: "/landing" },
  { path: "/auth" },
  { path: "/auth/forgot" },
  { path: "/auth/reset" },
  { path: "/legal/terms" },
  { path: "/legal/privacy" },
  // Token routes need a real token to truly load — we still smoke the
  // route-resolution layer with a fake token, expecting either a graceful
  // "invalid token" page or the InviteLanding component to render.
  {
    path: "/board-claim/:token",
    params: [{ name: "token", source: "static", value: "smoke-test-token-deadbeef" }],
  },
  {
    path: "/cli-auth/:id",
    params: [{ name: "id", source: "static", value: "smoke-test-id-deadbeef" }],
  },
  {
    path: "/invite/:token",
    params: [{ name: "token", source: "static", value: "smoke-test-token-deadbeef" }],
  },
];

/**
 * Authenticated routes that do NOT need a company prefix. In `local_trusted`
 * mode the suite already bypasses the auth gate, so these resolve under the
 * CloudAccessGate.
 */
export const UNPREFIXED_AUTH_ROUTES: RouteEntry[] = [
  { path: "/", expectsRedirect: true },
  { path: "/onboarding" },
  { path: "/instance", expectsRedirect: true },
  { path: "/instance/members", expectsRedirect: true },
  { path: "/instance/settings", expectsRedirect: true },
  { path: "/instance/settings/general" },
  { path: "/instance/settings/members" },
  { path: "/instance/settings/providers" },
  { path: "/instance/settings/heartbeats" },
  { path: "/instance/settings/experimental" },
  { path: "/instance/settings/plugins" },
  { path: "/instance/settings/adapters" },
  { path: "/settings/notifications" },
  { path: "/companies", expectsRedirect: true },
  { path: "/issues", expectsRedirect: true },
  { path: "/routines", expectsRedirect: true },
  { path: "/agents", expectsRedirect: true },
  { path: "/agents/new", expectsRedirect: true },
  { path: "/projects", expectsRedirect: true },
  { path: "/conversations", expectsRedirect: true },
  { path: "/hire", expectsRedirect: true },
  { path: "/weekly", expectsRedirect: true },
  { path: "/decisions", expectsRedirect: true },
  { path: "/departments", expectsRedirect: true },
  { path: "/tests/ux/chat", expectsRedirect: true },
  { path: "/tests/ux/runs", expectsRedirect: true },
];

/**
 * Company-prefixed routes (the bulk of the user-facing surface). Every entry
 * resolves to `/${companyPrefix}/<path>` at runtime.
 */
export const COMPANY_ROUTES: RouteEntry[] = [
  { path: "", companyPrefixed: true, expectsRedirect: true }, // /AGN → /AGN/dashboard
  { path: "dashboard", companyPrefixed: true },
  { path: "onboarding", companyPrefixed: true },
  { path: "companies", companyPrefixed: true },
  { path: "company/settings", companyPrefixed: true },
  { path: "company/import", companyPrefixed: true },
  { path: "org", companyPrefixed: true },
  { path: "departments", companyPrefixed: true, expectsRedirect: true },
  { path: "departments/chief-of-staff", companyPrefixed: true },
  { path: "agents", companyPrefixed: true, expectsRedirect: true },
  { path: "agents/all", companyPrefixed: true },
  { path: "agents/active", companyPrefixed: true },
  { path: "agents/paused", companyPrefixed: true },
  { path: "agents/error", companyPrefixed: true },
  { path: "agents/new", companyPrefixed: true },
  { path: "hire", companyPrefixed: true },
  {
    path: "agents/:agentId",
    params: [{ name: "agentId", source: "agent" }],
    companyPrefixed: true,
  },
  {
    path: "agents/:agentId/runs",
    params: [{ name: "agentId", source: "agent" }],
    companyPrefixed: true,
  },
  { path: "projects", companyPrefixed: true },
  {
    path: "projects/:projectId",
    params: [{ name: "projectId", source: "project" }],
    companyPrefixed: true,
  },
  {
    path: "projects/:projectId/overview",
    params: [{ name: "projectId", source: "project" }],
    companyPrefixed: true,
  },
  {
    path: "projects/:projectId/issues",
    params: [{ name: "projectId", source: "project" }],
    companyPrefixed: true,
  },
  {
    path: "projects/:projectId/configuration",
    params: [{ name: "projectId", source: "project" }],
    companyPrefixed: true,
  },
  {
    path: "projects/:projectId/budget",
    params: [{ name: "projectId", source: "project" }],
    companyPrefixed: true,
  },
  { path: "issues", companyPrefixed: true },
  {
    path: "issues/:issueId",
    params: [{ name: "issueId", source: "issue" }],
    companyPrefixed: true,
  },
  { path: "routines", companyPrefixed: true },
  { path: "goals", companyPrefixed: true },
  {
    path: "goals/:goalId",
    params: [{ name: "goalId", source: "goal" }],
    companyPrefixed: true,
  },
  { path: "approvals", companyPrefixed: true, expectsRedirect: true },
  { path: "approvals/pending", companyPrefixed: true },
  { path: "approvals/all", companyPrefixed: true },
  { path: "decisions", companyPrefixed: true },
  { path: "costs", companyPrefixed: true },
  { path: "integrations", companyPrefixed: true },
  { path: "activity", companyPrefixed: true },
  { path: "audit", companyPrefixed: true },
  { path: "weekly", companyPrefixed: true },
  { path: "conversations", companyPrefixed: true },
  { path: "inbox", companyPrefixed: true, expectsRedirect: true },
  { path: "inbox/mine", companyPrefixed: true },
  { path: "inbox/recent", companyPrefixed: true },
  { path: "inbox/unread", companyPrefixed: true },
  { path: "inbox/all", companyPrefixed: true },
  { path: "design-guide", companyPrefixed: true },
  { path: "tests/ux/chat", companyPrefixed: true },
  { path: "tests/ux/runs", companyPrefixed: true },
  { path: "instance/settings/adapters", companyPrefixed: true },
];

/**
 * The full set, in groups, that the smoke spec walks.
 */
export const ALL_ROUTE_GROUPS = [
  { label: "public", routes: PUBLIC_ROUTES },
  { label: "unprefixed-auth", routes: UNPREFIXED_AUTH_ROUTES },
  { label: "company-prefixed", routes: COMPANY_ROUTES },
] as const;

/**
 * Substitute params + (for company-prefixed routes) prepend the prefix.
 *
 * Returns null when a required param can't be derived (e.g. seed data has no
 * project for this company). The caller should `test.skip` that case.
 */
export function buildUrl(
  entry: RouteEntry,
  resolved: Record<string, string | null>,
  companyPrefix: string,
): string | null {
  let path = entry.path;
  if (entry.params) {
    for (const p of entry.params) {
      const value = resolved[p.name];
      if (!value) return null;
      path = path.replace(`:${p.name}`, value);
    }
  }
  if (entry.companyPrefixed) {
    return path === ""
      ? `/${companyPrefix}`
      : `/${companyPrefix}/${path.replace(/^\//, "")}`;
  }
  return path.startsWith("/") ? path : `/${path}`;
}
