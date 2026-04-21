/**
 * HubSpot OAuth provider configuration.
 *
 * Authorize:  https://app.hubspot.com/oauth/authorize
 * Token:      https://api.hubapi.com/oauth/v1/token
 * Scopes:     crm.objects.contacts.read crm.objects.deals.read crm.schemas.deals.read
 * Env:        HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET
 *
 * Quirks:
 * - HubSpot REQUIRES `response_type=code` in the authorize URL (unlike Slack).
 * - Token endpoint uses `client_secret_post` (not Basic auth).
 * - Returns access_token + refresh_token + expires_in. We store access_token now;
 *   refresh token handling is deferred to a future wave.
 */

export type HubSpotTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export const hubspotOAuthConfig = {
  kind: "hubspot" as const,
  authorizeUrl: "https://app.hubspot.com/oauth/authorize",
  tokenUrl: "https://api.hubapi.com/oauth/v1/token",
  scopes: [
    "crm.objects.contacts.read",
    "crm.objects.deals.read",
    "crm.schemas.deals.read",
  ],
  clientIdEnv: "HUBSPOT_CLIENT_ID",
  clientSecretEnv: "HUBSPOT_CLIENT_SECRET",

  isConfigured(): boolean {
    return !!(process.env.HUBSPOT_CLIENT_ID && process.env.HUBSPOT_CLIENT_SECRET);
  },

  getClientId(): string {
    return process.env.HUBSPOT_CLIENT_ID ?? "";
  },

  getClientSecret(): string {
    return process.env.HUBSPOT_CLIENT_SECRET ?? "";
  },

  /**
   * HubSpot requires response_type=code and space-separated scopes.
   */
  buildAuthorizeUrl(params: {
    redirectUri: string;
    state: string;
    clientId: string;
  }): string {
    const url = new URL(hubspotOAuthConfig.authorizeUrl);
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", hubspotOAuthConfig.scopes.join(" "));
    url.searchParams.set("state", params.state);
    url.searchParams.set("response_type", "code"); // Required by HubSpot
    return url.toString();
  },

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: hubspotOAuthConfig.getClientId(),
      client_secret: hubspotOAuthConfig.getClientSecret(),
      redirect_uri: params.redirectUri,
      code: params.code,
    });

    const resp = await fetch(hubspotOAuthConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(`HubSpot token exchange HTTP error: ${resp.status}`);
    }

    const data = (await resp.json()) as HubSpotTokenResponse;
    if (!data.access_token) {
      throw new Error(
        `HubSpot token exchange failed: ${data.error_description ?? data.error ?? "unknown"}`,
      );
    }

    return { accessToken: data.access_token };
  },
};
