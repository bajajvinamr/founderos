import { Cloud, Terminal, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { isHostedClaudeLocalAgent } from "@/lib/runner-adapter-types";

/**
 * Compact badge showing which provider + model + execution mode an agent
 * is configured to run on. Drops next to the agent name in lists and the
 * agent detail header so you never have to dig to see "what's this agent
 * running on".
 *
 * S8 P0.1 Phase 2B: when `VITE_FOUNDEROS_HOSTED_AGENTS_ENABLED=1` and the
 * adapter is `claude_local`, the badge swaps the CLI/API affordance for a
 * "Hosted on FounderOS" label + cloud icon. The agent's job runs in-process
 * on the server (Anthropic SDK handler), not on the founder's laptop runner
 * — so the existing CLI badge would mislead.
 */
export function AgentProviderBadge({
  adapterType,
  model,
  className,
}: {
  adapterType: string | null | undefined;
  model?: string | null;
  className?: string;
}) {
  if (!adapterType) return null;
  const meta = ADAPTER_META[adapterType] ?? {
    family: "other",
    label: adapterType,
    icon: "⬜",
    bg: "color-mix(in oklch, var(--muted-foreground) 14%, transparent)",
  };
  const isCli = adapterType.endsWith("_local");
  const isHosted = isHostedClaudeLocalAgent(adapterType);

  if (isHosted) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-background/40 px-1.5 py-0.5 text-[10px] leading-none",
          className,
        )}
        title={`Hosted on FounderOS${model ? ` · ${model}` : ""}`}
        data-testid="agent-provider-badge-hosted"
      >
        <span
          className="inline-flex h-3 w-3 items-center justify-center rounded-[3px] text-[9px]"
          style={{ background: meta.bg }}
          aria-hidden
        >
          {meta.icon}
        </span>
        <span className="font-medium text-foreground truncate max-w-[140px]">
          {model ?? "Hosted on FounderOS"}
        </span>
        <Cloud className="h-2.5 w-2.5 text-muted-foreground" aria-label="Hosted on FounderOS" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-background/40 px-1.5 py-0.5 text-[10px] leading-none",
        className,
      )}
      title={`${meta.label}${model ? ` · ${model}` : ""}${isCli ? " · CLI" : " · API"}`}
    >
      <span
        className="inline-flex h-3 w-3 items-center justify-center rounded-[3px] text-[9px]"
        style={{ background: meta.bg }}
        aria-hidden
      >
        {meta.icon}
      </span>
      <span className="font-medium text-foreground truncate max-w-[120px]">
        {model ?? meta.label}
      </span>
      {isCli ? (
        <Terminal className="h-2.5 w-2.5 text-muted-foreground" aria-label="CLI" />
      ) : (
        <Zap className="h-2.5 w-2.5 text-muted-foreground" aria-label="API" />
      )}
    </span>
  );
}

const ADAPTER_META: Record<string, { family: string; label: string; icon: string; bg: string }> = {
  claude_local: { family: "anthropic", label: "Claude CLI", icon: "🟠", bg: "color-mix(in oklch, #d97757 18%, transparent)" },
  codex_local:  { family: "openai",    label: "Codex CLI",  icon: "🔵", bg: "color-mix(in oklch, #10a37f 18%, transparent)" },
  openai_api:   { family: "openai",    label: "OpenAI API", icon: "🔵", bg: "color-mix(in oklch, #10a37f 18%, transparent)" },
  gemini_local: { family: "google",    label: "Gemini",     icon: "🟢", bg: "color-mix(in oklch, #4285f4 18%, transparent)" },
  cursor_local: { family: "other",     label: "Cursor CLI", icon: "🟣", bg: "color-mix(in oklch, #8b5cf6 18%, transparent)" },
  opencode_local: { family: "other",   label: "OpenCode",   icon: "⬛", bg: "color-mix(in oklch, var(--muted-foreground) 18%, transparent)" },
  openclaw_gateway: { family: "other", label: "OpenClaw",   icon: "⬛", bg: "color-mix(in oklch, var(--muted-foreground) 18%, transparent)" },
};
