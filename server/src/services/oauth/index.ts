/**
 * OAuth provider registry — lookup by kind.
 */

import { slackOAuthConfig } from "./slack.js";
import { hubspotOAuthConfig } from "./hubspot.js";
import { linkedinOAuthConfig } from "./linkedin.js";

export type OAuthKind = "slack" | "hubspot" | "linkedin";

export type OAuthProviderConfig = {
  kind: OAuthKind;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  isConfigured(): boolean;
  getClientId(): string;
  getClientSecret(): string;
  buildAuthorizeUrl(params: {
    redirectUri: string;
    state: string;
    clientId: string;
  }): string;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string }>;
};

const OAUTH_PROVIDERS: Record<OAuthKind, OAuthProviderConfig> = {
  slack: slackOAuthConfig,
  hubspot: hubspotOAuthConfig,
  linkedin: linkedinOAuthConfig,
};

export function getOAuthProvider(kind: OAuthKind): OAuthProviderConfig {
  return OAUTH_PROVIDERS[kind];
}

export const OAUTH_KINDS = Object.keys(OAUTH_PROVIDERS) as OAuthKind[];

export function isOAuthKind(kind: string): kind is OAuthKind {
  return OAUTH_KINDS.includes(kind as OAuthKind);
}

export { signOAuthState, verifyOAuthState } from "./state-store.js";
export type { OAuthStatePayload, VerifyOAuthStateResult } from "./state-store.js";
