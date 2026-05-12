// OpenAI API adapter — Phase C1 multi-provider implementation.
// Wraps openai@^4.x chat.completions streaming behind the FounderOS
// ServerAdapterModule contract. Stateless API adapter — no session codec.

export { execute } from "./server/execute.js";

export const type = "openai_api";
export const label = "OpenAI API";

export const DEFAULT_OPENAI_API_MODEL = "gpt-4o";

export const models = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "o3", label: "o3" },
  { id: "o3-mini", label: "o3 mini" },
  { id: "o1", label: "o1" },
  { id: "o1-mini", label: "o1 mini" },
];

export const agentConfigurationDoc = `# openai_api agent configuration

Adapter: openai_api

Use when:
- You want FounderOS to call OpenAI's hosted Chat Completions API directly.
- The instance has an OpenAI API key configured in Settings → API Keys (family = "openai").

Don't use when:
- You want to invoke OpenAI through a self-hosted gateway (use openclaw_gateway).
- You want a local CLI agent (use claude_local, codex_local, opencode_local, etc.).

Core fields:
- model (string, optional): OpenAI model id; defaults to "${DEFAULT_OPENAI_API_MODEL}".
- promptTemplate (string, optional): run prompt template; supports {{agent.id}}, {{agent.name}}, {{agent.companyId}}.
- maxTokens (number, optional): max completion tokens per run (default 4096).

Operational fields:
- timeoutSec (number, optional): per-run timeout in seconds (default 120).

Notes:
- The API key is resolved at run time via instanceApiKeysService.getDecrypted("openai", "api"). It is NOT read from the adapter config or process.env.
- Streaming is always enabled; tokens stream to the run log as they arrive.
- Usage and cost (estimated at GPT-4o pricing) are recorded in the run summary.
- This adapter does not persist session state across runs — each invocation is stateless.
`;
