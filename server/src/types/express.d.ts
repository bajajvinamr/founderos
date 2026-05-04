export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "runner" | "none";
        userId?: string;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        /** Set on type="runner" — links audit log entries back to the issuing token. */
        runnerTokenId?: string;
        source?:
          | "local_implicit"
          | "session"
          | "board_key"
          | "agent_key"
          | "agent_jwt"
          | "runner_token"
          | "none";
      };
      /** Raw request body bytes, attached by the express.json verify callback in app.ts. */
      rawBody?: Buffer;
      /** Correlation ID for this request — set by requestIdMiddleware, echoed via x-request-id. */
      requestId?: string;
    }
  }
}
