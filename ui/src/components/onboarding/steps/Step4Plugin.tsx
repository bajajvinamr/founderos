import { useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2, Check, X, Terminal, Key, Clock } from "lucide-react";
import { api } from "@/api/client";
import {
  INTEGRATION_KEYS,
  INTEGRATION_LABELS,
  type AdapterChoice,
  type IntegrationKey,
} from "../onboarding-types.js";

export type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid" }
  | { status: "invalid"; reason: string };

interface Props {
  adapterChoice: AdapterChoice;
  anthropicKey: string;
  integrations: Record<IntegrationKey, boolean>;
  validation: ValidationState;
  onAdapterChoiceChange: (next: AdapterChoice) => void;
  onAnthropicKeyChange: (next: string) => void;
  onIntegrationsChange: (next: Record<IntegrationKey, boolean>) => void;
  onValidationChange: (next: ValidationState) => void;
}

const INTEGRATION_DESCRIPTIONS: Record<IntegrationKey, string> = {
  slack: "CoS posts the weekly wrap + nudges to a channel.",
  hubspot: "Growth reads the pipeline, drafts follow-ups.",
  notion: "Content syncs docs bi-directionally.",
  posthog: "Growth reads product analytics for experiments.",
  linkedin: "Content + Growth ghost-write posts in your voice.",
};

const ADAPTER_OPTIONS: Array<{
  value: AdapterChoice;
  label: string;
  subtitle: string;
  icon: typeof Terminal;
  recommended?: boolean;
}> = [
  {
    value: "claude_local",
    label: "Claude Code CLI (local)",
    subtitle: "You have claude installed locally. Agents use your existing Claude session — no key needed. Perfect if you're on Claude Pro.",
    icon: Terminal,
    recommended: true,
  },
  {
    value: "anthropic_api",
    label: "Anthropic API key",
    subtitle: "Paste an sk-ant-... key. Required for hosted deploys where we can't shell into a local CLI.",
    icon: Key,
  },
  {
    value: "skip",
    label: "Set up later",
    subtitle: "Skip for now. You can add this in Settings → Providers anytime.",
    icon: Clock,
  },
];

export function Step4Plugin({
  adapterChoice,
  anthropicKey,
  integrations,
  validation,
  onAdapterChoiceChange,
  onAnthropicKeyChange,
  onIntegrationsChange,
  onValidationChange,
}: Props) {
  const [localKey, setLocalKey] = useState(anthropicKey);

  async function validate() {
    const trimmed = localKey.trim();
    if (!trimmed) return;
    onValidationChange({ status: "validating" });
    try {
      const result = await api.post<{ valid: boolean; reason?: string }>(
        "/byo-key/validate",
        { provider: "anthropic", key: trimmed },
      );
      if (result.valid) {
        onAnthropicKeyChange(trimmed);
        onValidationChange({ status: "valid" });
      } else {
        onValidationChange({
          status: "invalid",
          reason: result.reason ?? "unknown",
        });
      }
    } catch (err) {
      onValidationChange({
        status: "invalid",
        reason: err instanceof Error ? err.message : "network_error",
      });
    }
  }

  function toggleIntegration(key: IntegrationKey) {
    onIntegrationsChange({
      ...integrations,
      [key]: !integrations[key],
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Plug in your brain
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          How should agents authenticate with Claude? Integrations are optional
          — you can connect them later.
        </p>
      </div>

      {/* Adapter choice */}
      <div className="space-y-2">
        {ADAPTER_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isSelected = adapterChoice === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onAdapterChoiceChange(opt.value);
                if (opt.value !== "anthropic_api") {
                  onValidationChange({ status: "idle" });
                }
              }}
              className={cn(
                "w-full text-left rounded-md border px-4 py-3 transition-colors relative",
                isSelected
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/40",
              )}
            >
              {opt.recommended && (
                <span className="absolute -top-1.5 right-3 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                  Recommended
                </span>
              )}
              <div className="flex items-start gap-3">
                <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                    {opt.subtitle}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* API key input — only when user picked anthropic_api */}
      {adapterChoice === "anthropic_api" && (
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Anthropic API key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Saved encrypted to this company. Starts with{" "}
                <span className="font-mono">sk-ant-</span>.
              </p>
            </div>
            {validation.status === "valid" && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                Valid
              </span>
            )}
            {validation.status === "invalid" && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <X className="h-3.5 w-3.5" />
                {validation.reason}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              placeholder="sk-ant-api03-..."
              value={localKey}
              onChange={(e) => {
                setLocalKey(e.target.value);
                if (validation.status !== "idle") {
                  onValidationChange({ status: "idle" });
                }
              }}
            />
            <button
              type="button"
              disabled={!localKey.trim() || validation.status === "validating"}
              onClick={() => void validate()}
              className={cn(
                "rounded-md border border-border px-3 py-2 text-xs font-medium",
                "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {validation.status === "validating" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : validation.status === "valid" ? (
                "Revalidate"
              ) : (
                "Validate"
              )}
            </button>
          </div>
        </div>
      )}

      {adapterChoice === "claude_local" && (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Make sure <span className="font-mono text-foreground">claude</span> is installed and authenticated on the machine running FounderOS. Run <span className="font-mono text-foreground">claude</span> once in a terminal to log in if you haven't already. Hosted deploys (Fly.io) don't have a CLI — pick "Anthropic API key" for those.
        </div>
      )}

      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Integrations (optional)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {INTEGRATION_KEYS.map((key) => {
            const enabled = integrations[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleIntegration(key)}
                className={cn(
                  "text-left rounded-md border px-3.5 py-3 transition-colors",
                  enabled
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {INTEGRATION_LABELS[key]}
                  </p>
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    {enabled ? "CONNECT LATER" : "SKIP"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  {INTEGRATION_DESCRIPTIONS[key]}
                </p>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Toggling marks the integration for setup on the Integrations page.
          Nothing is connected until you authenticate there.
        </p>
      </div>
    </div>
  );
}
