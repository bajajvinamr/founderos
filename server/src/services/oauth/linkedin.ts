/**
 * LinkedIn OAuth provider configuration.
 *
 * Authorize:  https://www.linkedin.com/oauth/v2/authorization
 * Token:      https://www.linkedin.com/oauth/v2/accessToken
 * Scopes:     w_member_social r_liteprofile
 * Env:        LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 *
 * Quirks:
 * - LinkedIn requires response_type=code.
 * - Token endpoint uses client_secret_post (form body, not Basic auth).
 * - Scopes are space-separated.
 */

export type LinkedInTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export const linkedinOAuthConfig = {
  kind: "linkedin" as const,
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: ["w_member_social", "r_liteprofile"],
  clientIdEnv: "LINKEDIN_CLIENT_ID",
  clientSecretEnv: "LINKEDIN_CLIENT_SECRET",

  isConfigured(): boolean {
    return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
  },

  getClientId(): string {
    return process.env.LINKEDIN_CLIENT_ID ?? "";
  },

  getClientSecret(): string {
    return process.env.LINKEDIN_CLIENT_SECRET ?? "";
  },

  buildAuthorizeUrl(params: {
    redirectUri: string;
    state: string;
    clientId: string;
  }): string {
    const url = new URL(linkedinOAuthConfig.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", linkedinOAuthConfig.scopes.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  },

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: linkedinOAuthConfig.getClientId(),
      client_secret: linkedinOAuthConfig.getClientSecret(),
    });

    const resp = await fetch(linkedinOAuthConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(`LinkedIn token exchange HTTP error: ${resp.status}`);
    }

    const data = (await resp.json()) as LinkedInTokenResponse;
    if (!data.access_token) {
      throw new Error(
        `LinkedIn token exchange failed: ${data.error_description ?? data.error ?? "unknown"}`,
      );
    }

    return { accessToken: data.access_token };
  },
};
