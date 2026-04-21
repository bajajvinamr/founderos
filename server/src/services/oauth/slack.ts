/**
 * Slack OAuth provider configuration.
 *
 * Authorize:  https://slack.com/oauth/v2/authorize
 * Token:      https://slack.com/api/oauth.v2.access
 * Scopes:     chat:write channels:read groups:read
 * Env:        SLACK_CLIENT_ID, SLACK_CLIENT_SECRET
 *
 * Quirk: Slack v2 token endpoint returns a nested object.
 * The bot token is at `access_token` (top-level), which is the xoxb-... token.
 */

export type SlackTokenResponse = {
  ok: boolean;
  access_token?: string;
  error?: string;
};

export const slackOAuthConfig = {
  kind: "slack" as const,
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  scopes: ["chat:write", "channels:read", "groups:read"],
  clientIdEnv: "SLACK_CLIENT_ID",
  clientSecretEnv: "SLACK_CLIENT_SECRET",

  isConfigured(): boolean {
    return !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
  },

  getClientId(): string {
    return process.env.SLACK_CLIENT_ID ?? "";
  },

  getClientSecret(): string {
    return process.env.SLACK_CLIENT_SECRET ?? "";
  },

  /**
   * Slack token exchange uses Basic auth (client_id:client_secret) and form-encoded body.
   * Note: Slack does NOT use response_type=code in the authorize URL — it uses `code` grant
   * implicitly. Also note the token endpoint uses HTTP Basic auth, not client_secret_post.
   */
  buildAuthorizeUrl(params: {
    redirectUri: string;
    state: string;
    clientId: string;
  }): string {
    const url = new URL(slackOAuthConfig.authorizeUrl);
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", slackOAuthConfig.scopes.join(","));
    url.searchParams.set("state", params.state);
    // No response_type needed — Slack implicitly uses code flow
    return url.toString();
  },

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string }> {
    const clientId = slackOAuthConfig.getClientId();
    const clientSecret = slackOAuthConfig.getClientSecret();

    const body = new URLSearchParams({
      code: params.code,
      redirect_uri: params.redirectUri,
    });

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const resp = await fetch(slackOAuthConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(`Slack token exchange HTTP error: ${resp.status}`);
    }

    const data = (await resp.json()) as SlackTokenResponse;
    if (!data.ok || !data.access_token) {
      throw new Error(`Slack token exchange failed: ${data.error ?? "unknown"}`);
    }

    return { accessToken: data.access_token };
  },
};
