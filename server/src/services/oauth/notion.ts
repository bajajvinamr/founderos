/**
 * Notion OAuth provider configuration.
 *
 * Authorize:  https://api.notion.com/v1/oauth/authorize
 * Token:      https://api.notion.com/v1/oauth/token
 * Env:        NOTION_CLIENT_ID, NOTION_CLIENT_SECRET
 *
 * Quirks:
 * - Notion public integrations use `owner=user` in the authorize URL and do
 *   NOT pass `scope` (scopes are configured per integration in the Notion UI).
 * - Notion REQUIRES `response_type=code` in the authorize URL.
 * - Token endpoint uses HTTP Basic auth (client_id:client_secret base64) with
 *   a JSON body — different from HubSpot (POST form) and similar in spirit to
 *   Slack, but JSON-bodied.
 * - Response includes: access_token, workspace_id, workspace_name, bot_id,
 *   owner. We return only access_token here; workspace metadata is persisted
 *   in `integrations.config` by the OAuth callback handler (other sub owns
 *   that wiring — see server/src/index.ts).
 *
 * Docs: https://developers.notion.com/docs/authorization
 */

export type NotionTokenResponse = {
  access_token?: string;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: unknown;
  duplicated_template_id?: string | null;
  error?: string;
  error_description?: string;
};

export const notionOAuthConfig = {
  kind: "notion" as const,
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  /**
   * Notion does NOT accept a `scope` parameter on the authorize URL — scopes
   * are configured per integration in the Notion admin UI. We keep this list
   * empty to conform to the shared OAuthProviderConfig shape.
   */
  scopes: [] as string[],
  clientIdEnv: "NOTION_CLIENT_ID",
  clientSecretEnv: "NOTION_CLIENT_SECRET",

  isConfigured(): boolean {
    return !!(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
  },

  getClientId(): string {
    return process.env.NOTION_CLIENT_ID ?? "";
  },

  getClientSecret(): string {
    return process.env.NOTION_CLIENT_SECRET ?? "";
  },

  /**
   * Notion authorize URL: response_type=code, owner=user, no scope param.
   */
  buildAuthorizeUrl(params: {
    redirectUri: string;
    state: string;
    clientId: string;
  }): string {
    const url = new URL(notionOAuthConfig.authorizeUrl);
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("state", params.state);
    return url.toString();
  },

  /**
   * Notion token exchange uses HTTP Basic auth + JSON body.
   */
  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string }> {
    const clientId = notionOAuthConfig.getClientId();
    const clientSecret = notionOAuthConfig.getClientSecret();

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );

    const resp = await fetch(notionOAuthConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Notion token exchange HTTP error: ${resp.status}${body ? ` — ${body}` : ""}`,
      );
    }

    const data = (await resp.json()) as NotionTokenResponse;
    if (!data.access_token) {
      throw new Error(
        `Notion token exchange failed: ${data.error_description ?? data.error ?? "unknown"}`,
      );
    }

    return { accessToken: data.access_token };
  },
};
