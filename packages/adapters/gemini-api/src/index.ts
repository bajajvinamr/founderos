export const DEFAULT_GEMINI_API_MODEL = "gemini-2.5-pro";
export const GEMINI_API_ADAPTER_TYPE = "gemini_api";

export const type = GEMINI_API_ADAPTER_TYPE;
export const label = "Gemini API";

export const models = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro (legacy)" },
];

export const agentConfigurationDoc = `# gemini_api agent configuration

Adapter: gemini_api

Use when:
- You want FounderOS to call Google's Gemini API directly via @google/generative-ai.
- The instance has a Google API key configured in Settings → API Keys (family = "google").

Don't use when:
- You want a local CLI agent (use gemini_local).
- You want gateway-mediated access (use openclaw_gateway).

Core fields:
- model (string, optional): Gemini model id; defaults to "${DEFAULT_GEMINI_API_MODEL}".
- promptTemplate (string, optional): run prompt template; supports {{agent.id}}, {{agent.name}}, {{run.id}}.

Operational fields:
- timeoutSec (number, optional): per-run timeout in seconds (default 120).

Notes:
- The API key is resolved at run time via instanceApiKeysService.getDecrypted("google", "api"). It is NOT read from the adapter config or process.env.
- Streaming is always enabled; tokens stream to the run log as they arrive.
- Usage (input/output/cached tokens) is recorded when Gemini returns usageMetadata.
- cost_usd is not surfaced by the Gemini API; reported as null.
- This adapter does not persist session state across runs — each invocation is stateless.
`;
