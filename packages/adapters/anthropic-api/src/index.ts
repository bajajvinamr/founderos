// Anthropic API adapter — direct HTTP path via @anthropic-ai/sdk.
// Wraps client.messages.create({stream: true}) behind the FounderOS
// ServerAdapterModule contract. Stateless API adapter — no session codec.

export { execute } from "./server/execute.js";

export const type = "anthropic_api";
export const label = "Anthropic API";

export const DEFAULT_ANTHROPIC_API_MODEL = "claude-opus-4-7";

/**
 * Known Anthropic model ids. Strings only — version-dated variants like
 * `claude-opus-4-7-YYYYMMDD` are accepted by the API and matched by the
 * pricing-lookup prefix scan in execute.ts, but they are not advertised
 * in this list because the bare ids are the supported, canonical form.
 */
export const models = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# anthropic_api agent configuration

Adapter: anthropic_api

Use when:
- You want FounderOS to call the Anthropic Messages API directly.
- The instance has an Anthropic API key configured in Settings -> API Keys (family = "anthropic", mode = "api").

Don't use when:
- The container has the \`claude\` CLI authenticated and you want session continuity (use claude_local).
- You want OAuth/Claude-Code-credential auth (use claude_local or BYO Runner).

Core fields:
- model (string, optional): Anthropic model id; defaults to "${DEFAULT_ANTHROPIC_API_MODEL}".
- promptTemplate (string, optional): run prompt template; supports {{agent.id}}, {{agent.name}}, {{agent.companyId}}.
- maxTokens (number, optional): max completion tokens per run (default 4096; required by the Anthropic API).
- thinking (object | null, optional): extended thinking config. Defaults to {type: "adaptive"} on Opus models; pass null to disable.

Operational fields:
- timeoutSec (number, optional): per-run timeout in seconds (default 120).

Notes:
- The API key is resolved at run time via instanceApiKeysService.getDecrypted("anthropic", "api"). It is NOT read from the adapter config or process.env.
- Streaming is always enabled; tokens stream to the run log as they arrive.
- Usage and cost (estimated at the model's published per-1M pricing) are recorded in the run summary. Cached input tokens (prompt-cache reads) are tracked separately.
- This adapter does not persist session state across runs — each invocation is stateless. If you need conversational context, embed it in the prompt template upstream.
- Adaptive thinking is the Opus 4.7 default. If you change \`model\` to a Haiku or older variant that doesn't support extended thinking, pass \`thinking: null\` to avoid a 400.
`;
