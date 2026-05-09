import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  Clock,
  Key,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { validateProviderKey } from "@/api/providers";
import {
  INTEGRATION_KEYS,
  INTEGRATION_LABELS,
  type AdapterChoice,
  type IntegrationKey,
} from "../onboarding-types.js";

/**
 * Wizard-side validation state for the AI provider key step.
 *
 * Lifecycle:
 *   idle      — no input yet, or user just cleared the field
 *   validating— a debounced fetch is in flight (spinner shown)
 *   valid     — server confirmed the key works (Next unblocked)
 *   invalid   — server rejected with a `reason` token
 *   warning   — transport failure / rate limit; user MAY skip and
 *               re-validate at submit-time (belt-and-suspenders)
 *   skipped   — user clicked "Skip validation" while in `warning`
 *               state; Next unblocks and the bootstrap call is the
 *               sole gate against a bad key
 */
export type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "warning"; reason: string }
  | { status: "skipped" };

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
    subtitle:
      "You have claude installed locally. Agents use your existing Claude session — no key needed. Perfect if you're on Claude Pro.",
    icon: Terminal,
    recommended: true,
  },
  {
    value: "anthropic_api",
    label: "Anthropic API key",
    subtitle:
      "Paste an sk-ant-... key. Required for hosted deploys where we can't shell into a local CLI.",
    icon: Key,
  },
  {
    value: "skip",
    label: "Set up later",
    subtitle: "Skip for now. You can add this in Settings → Providers anytime.",
    icon: Clock,
  },
];

/** Debounce window in ms for live key validation. Tuned to balance
 *  perceived responsiveness against the server-side per-IP rate limit
 *  (10 / 5min). At 600ms a careful typist won't trigger more than 1-2
 *  validations per key. */
const VALIDATION_DEBOUNCE_MS = 600;

/** Translate a stable server reason token into UI copy. Unknown tokens
 *  fall through unchanged so engineers can grep server logs by the
 *  same string a user reports. */
function reasonToLabel(reason: string): string {
  switch (reason) {
    case "invalid_key":
      return "Key was rejected by Anthropic";
    case "permission_denied":
      return "Key was rejected by Anthropic";
    case "empty_key":
      return "Enter your Anthropic key";
    case "unsupported_format":
      return "Key format isn't recognized — should start with sk-ant-";
    case "rate_limited":
      return "Too many checks — wait a moment and try again";
    case "network_error":
      return "Couldn't reach the validation server";
    case "timeout":
      return "Validation timed out — Anthropic may be slow right now";
    case "nonce_failed":
      return "Couldn't start a validation session — try again";
    default:
      return reason;
  }
}

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

  // The current in-flight AbortController. Held in a ref so we can
  // cancel it when (a) the user types again before the debounce fires,
  // (b) the user changes the adapter away from anthropic_api, or (c)
  // the component unmounts.
  const abortRef = useRef<AbortController | null>(null);

  // Live debounced validation: any time the trimmed key changes AND
  // the user is on the anthropic_api branch, schedule a validation
  // 600ms after the last keystroke. Earlier scheduled validations are
  // cancelled both at the timer level (clearTimeout) and at the fetch
  // level (AbortController.abort) so stale results never reach state.
  useEffect(() => {
    if (adapterChoice !== "anthropic_api") return;
    const trimmed = localKey.trim();

    // Empty input — clear any in-flight call and revert to idle.
    if (trimmed.length === 0) {
      abortRef.current?.abort();
      abortRef.current = null;
      // Only push idle if we're not already idle — avoid render churn.
      if (validation.status !== "idle") {
        onValidationChange({ status: "idle" });
      }
      return;
    }

    const timer = setTimeout(() => {
      // Cancel any prior in-flight before spinning up a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      onValidationChange({ status: "validating" });
      void validateProviderKey("anthropic", trimmed, controller.signal).then(
        (result) => {
          // The signal might have been aborted between fetch resolving
          // and this then() running. Trust both `result.aborted` AND
          // the controller's signal state.
          if (controller.signal.aborted || result.aborted) return;

          if (result.valid) {
            onAnthropicKeyChange(trimmed);
            onValidationChange({ status: "valid" });
            return;
          }

          const reason = result.reason ?? "unknown";
          // network_error / rate_limited / nonce_failed: not a key
          // problem — let the user opt past validation. Bootstrap will
          // re-check at submit-time.
          if (
            reason === "network_error" ||
            reason === "rate_limited" ||
            reason === "nonce_failed"
          ) {
            onValidationChange({ status: "warning", reason });
            return;
          }
          onValidationChange({ status: "invalid", reason });
        },
      );
    }, VALIDATION_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [
    adapterChoice,
    localKey,
    onAnthropicKeyChange,
    onValidationChange,
    // We intentionally read `validation.status` inside the effect but
    // do NOT include `validation` in the dep array — the effect should
    // re-fire on key/adapter change only, not on every status flip
    // (which would loop). Including `onValidationChange` is safe
    // because callers wrap it in `useState`'s setter (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);

  // Cancel any in-flight when this component unmounts (user closes
  // the wizard / advances to next step).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  function handleSkipValidation() {
    abortRef.current?.abort();
    abortRef.current = null;
    // Persist the typed key as-is — the bootstrap call will re-validate.
    onAnthropicKeyChange(localKey.trim());
    onValidationChange({ status: "skipped" });
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
                  // Cancel any in-flight when switching away from
                  // anthropic_api so a stale result never resurfaces.
                  abortRef.current?.abort();
                  abortRef.current = null;
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
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Anthropic API key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Saved encrypted to this company. Starts with{" "}
                <span className="font-mono">sk-ant-</span>.
              </p>
            </div>
            {/* Inline status indicator. One of: validating, valid,
                invalid, warning, skipped. Idle renders nothing. */}
            <div
              className="text-xs whitespace-nowrap"
              data-testid="validation-status"
              aria-live="polite"
            >
              {validation.status === "validating" && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Validating…
                </span>
              )}
              {validation.status === "valid" && (
                <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                  <Check className="h-3.5 w-3.5" />
                  Valid key
                </span>
              )}
              {validation.status === "invalid" && (
                <span className="flex items-center gap-1 text-destructive">
                  <X className="h-3.5 w-3.5" />
                  {reasonToLabel(validation.reason)}
                </span>
              )}
              {validation.status === "warning" && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Couldn&apos;t validate
                </span>
              )}
              {validation.status === "skipped" && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Skipped — re-checked at submit
                </span>
              )}
            </div>
          </div>

          <input
            type="password"
            autoComplete="off"
            data-testid="anthropic-key-input"
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            placeholder="sk-ant-api03-..."
            value={localKey}
            onChange={(e) => {
              setLocalKey(e.target.value);
              // When the user starts editing again after a terminal
              // state, drop back to idle so the indicator clears
              // visually before the new validation fires.
              if (
                validation.status === "valid" ||
                validation.status === "invalid" ||
                validation.status === "warning" ||
                validation.status === "skipped"
              ) {
                onValidationChange({ status: "idle" });
              }
            }}
          />

          {/* Warning state surfaces an explicit "Skip validation" link
              so users blocked by network/rate-limit can still finish
              onboarding. The bootstrap call will re-validate at submit
              time — belt and suspenders. */}
          {validation.status === "warning" && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-900/90 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200/90 leading-relaxed">
              <p>
                Could not validate (network or rate limit:{" "}
                <span className="font-mono">
                  {reasonToLabel(validation.reason)}
                </span>
                ). You can continue but the key will be re-checked at submit.
              </p>
              <button
                type="button"
                onClick={handleSkipValidation}
                data-testid="skip-validation"
                className="mt-1.5 text-amber-700 dark:text-amber-300 underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
              >
                Skip validation and continue
              </button>
            </div>
          )}
        </div>
      )}

      {adapterChoice === "claude_local" && (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Make sure <span className="font-mono text-foreground">claude</span> is
          installed and authenticated on the machine running FounderOS. Run{" "}
          <span className="font-mono text-foreground">claude</span> once in a
          terminal to log in if you haven&apos;t already. Hosted deploys
          (Fly.io) don&apos;t have a CLI — pick &quot;Anthropic API key&quot;
          for those.
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
