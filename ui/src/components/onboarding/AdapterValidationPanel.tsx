/**
 * Step 4 advance-gate panel (2026-05-12).
 *
 * Renders the per-adapter validation surface that gates the wizard's
 * Continue button. The wizard cannot advance to Step 5 until this
 * panel has reported `onValidated(true)` for the adapter the founder
 * currently has selected. Switching to a different adapter resets the
 * validated flag — handled by the wizard, not this component.
 *
 * Two paths:
 *
 * 1. `api_key` adapters (anthropic_api / openai_api / google_api):
 *    inline key input + Validate button that calls
 *    `validateProviderKey()` against `POST /api/providers/validate-key`.
 *    On 200 success the panel flips green and `onValidated(true)` fires.
 *
 * 2. `subscription` adapters (claude_code / gemini_cli / codex_cli):
 *    explicit "Confirm CLI is installed on this machine" attestation
 *    button. We do NOT fake a server-side `which <binary>` probe — the
 *    canonical FounderOS server runs on Fly, not on the founder's
 *    laptop, so any server-side probe would be meaningless. Honest
 *    attestation > theater-validation. The runner heartbeat surfaces
 *    real-vs-fake later, after onboarding completes.
 */

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  validateProviderKey,
  type ProviderId,
  type ValidateProviderKeyResult,
} from "@/api/providers";
import {
  ADAPTER_AUTH_MODES,
  type AdapterChoice,
} from "./onboarding-types.js";

interface AdapterValidationPanelProps {
  /** The currently-selected adapter from Step 4's chooser. */
  adapterChoice: AdapterChoice;
  /** Founder-entered API key for `api_key` adapters. */
  apiKey: string;
  onApiKeyChange: (next: string) => void;
  /** True iff this exact adapter has been validated. */
  validated: boolean;
  /**
   * Fired with `true` when validation succeeds, `false` when it fails
   * (so the wizard can flip its gate back closed if the founder edits
   * a previously-valid key into garbage).
   */
  onValidated: (validated: boolean) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "valid" }
  | { kind: "invalid"; reason: string };

/**
 * Map the chosen api_key adapter to the `ProviderId` accepted by
 * `validateProviderKey()`. Returns null for adapters that are not
 * `api_key`-shaped (the panel renders the subscription path instead).
 */
function adapterToProviderId(choice: AdapterChoice): ProviderId | null {
  if (choice === "anthropic_api") return "anthropic";
  if (choice === "openai_api") return "openai_api";
  if (choice === "google_api") return "google_api";
  return null;
}

function reasonToCopy(reason: string): string {
  if (reason === "invalid_key" || reason === "permission_denied") {
    return "Key was rejected. Double-check it and try again.";
  }
  if (reason === "rate_limited") {
    return "Too many attempts — wait a minute and try again.";
  }
  if (reason === "empty_key") {
    return "Paste your API key above first.";
  }
  if (reason === "network_error") {
    return "Couldn't reach the provider. Check your internet.";
  }
  if (reason === "timeout") {
    return "Validation timed out — try again.";
  }
  // 2026-05-18 — explicit copy for nonce path failures so the founder
  // gets actionable feedback instead of generic "Validation failed".
  // `nonce_failed` = our own server's nonce issuance broke (rare, but
  // distinct from a key problem — user shouldn't waste time re-pasting).
  if (reason === "nonce_failed") {
    return "Couldn't reach FounderOS to validate. Refresh and try again.";
  }
  if (reason === "unknown") {
    return "Validation got an unexpected response. Try again, or skip and use a CLI provider.";
  }
  return "Validation failed. Try again.";
}

export function AdapterValidationPanel({
  adapterChoice,
  apiKey,
  onApiKeyChange,
  validated,
  onValidated,
}: AdapterValidationPanelProps) {
  const authMode = ADAPTER_AUTH_MODES[adapterChoice];
  const isApiKeyAdapter = authMode === "api";
  const [status, setStatus] = useState<Status>(
    validated ? { kind: "valid" } : { kind: "idle" },
  );
  const abortRef = useRef<AbortController | null>(null);

  // If the wizard externally clears `validated` (e.g., founder switched
  // tiles), reflect that locally so the green check disappears.
  useEffect(() => {
    if (!validated && status.kind === "valid") {
      setStatus({ kind: "idle" });
    }
  }, [validated, status.kind]);

  // Abort any in-flight key validation when the panel unmounts (founder
  // navigates back, etc.). This prevents a stale success from racing
  // past a subsequent Cancel.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleValidateKey() {
    const providerId = adapterToProviderId(adapterChoice);
    if (!providerId) return;
    // Cancel any prior in-flight validation so the latest click wins.
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setStatus({ kind: "validating" });
    let result: ValidateProviderKeyResult;
    try {
      result = await validateProviderKey(
        providerId,
        apiKey,
        abortRef.current.signal,
      );
    } catch (err) {
      // `validateProviderKey` re-throws AbortError specifically; everything
      // else surfaces as `{valid:false, reason:"network_error"}` already.
      if ((err as { name?: string })?.name === "AbortError") return;
      setStatus({ kind: "invalid", reason: "network_error" });
      onValidated(false);
      return;
    }
    if (result.aborted) return;
    if (result.valid) {
      setStatus({ kind: "valid" });
      onValidated(true);
    } else {
      setStatus({ kind: "invalid", reason: result.reason ?? "unknown" });
      onValidated(false);
    }
  }

  function handleConfirmCliInstalled() {
    setStatus({ kind: "valid" });
    onValidated(true);
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (isApiKeyAdapter) {
    const providerLabel =
      adapterChoice === "anthropic_api"
        ? "Anthropic"
        : adapterChoice === "openai_api"
        ? "OpenAI"
        : "Google";
    return (
      <div
        className="rounded-md border border-border p-4 space-y-3"
        data-testid="adapter-validation-panel"
        data-validation-mode="api-key"
      >
        <div>
          <p className="text-sm font-medium">
            Paste your {providerLabel} API key
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            We validate the key against {providerLabel} before you continue.
            The key is sent to the server only once for this check.
          </p>
        </div>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${providerLabel} API key`}
          data-testid="adapter-validation-api-key-input"
          value={apiKey}
          onChange={(e) => {
            onApiKeyChange(e.target.value);
            // Editing the key invalidates any prior validation.
            if (validated || status.kind === "valid" || status.kind === "invalid") {
              setStatus({ kind: "idle" });
              onValidated(false);
            }
          }}
          placeholder="sk-..."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            type="button"
            onClick={() => void handleValidateKey()}
            disabled={
              status.kind === "validating" || apiKey.trim().length === 0
            }
            data-testid="adapter-validation-validate-btn"
          >
            {status.kind === "validating" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Validating…
              </>
            ) : (
              <>
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                Validate key
              </>
            )}
          </Button>
          {status.kind === "valid" && (
            <span
              className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400"
              data-testid="adapter-validation-status-valid"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Key validated
            </span>
          )}
          {status.kind === "invalid" && (
            <span
              className="inline-flex items-center gap-1 text-xs text-destructive"
              data-testid="adapter-validation-status-invalid"
            >
              <XCircle className="h-3.5 w-3.5" />
              {reasonToCopy(status.reason)}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Subscription path — local-CLI runner walkthrough.
  //
  // 2026-05-18 — replaced the honor-system "I have the CLI installed"
  // attestation with an explicit 4-step walkthrough. The prior version
  // collected an attestation, advanced the wizard, then the agent ran
  // server-side on Fly where the CLI binary does NOT exist — silent
  // failure at first heartbeat. The walkthrough is honest about what
  // happens next: we install a runner (one-time), the runner runs the
  // CLI on the founder's laptop, and the runner setup happens
  // post-onboarding via the dashboard banner (companyId doesn't exist
  // yet here, so token issuance can't happen in-wizard).
  const cliLabel =
    adapterChoice === "claude_local"
      ? "Claude Code"
      : adapterChoice === "gemini_local"
      ? "Gemini CLI"
      : adapterChoice === "codex_local"
      ? "Codex CLI"
      : "the CLI";
  const installBin =
    adapterChoice === "claude_local"
      ? "claude"
      : adapterChoice === "gemini_local"
      ? "gemini"
      : adapterChoice === "codex_local"
      ? "codex"
      : "your CLI";
  return (
    <div
      className={cn(
        "rounded-md border p-4 space-y-4",
        status.kind === "valid"
          ? "border-green-600/40 bg-green-600/5 dark:border-green-400/40 dark:bg-green-400/5"
          : "border-border",
      )}
      data-testid="adapter-validation-panel"
      data-validation-mode="subscription"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">
          You'll connect {cliLabel} via the FounderOS runner
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Your AI teammates need a small runner on your laptop to use
          the {cliLabel} subscription. It's a one-time, two-minute
          setup that happens right after we create your company.
        </p>
      </div>
      <ol className="space-y-2 text-xs">
        <li className="flex gap-2">
          <span className="font-mono font-semibold text-muted-foreground shrink-0">
            1.
          </span>
          <span>
            Make sure <code className="font-mono">{installBin}</code> is
            already installed and signed in on your laptop.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-mono font-semibold text-muted-foreground shrink-0">
            2.
          </span>
          <span>
            Install the runner once:{" "}
            <code className="font-mono px-1 py-0.5 rounded bg-muted">
              npm i -g @founderos/runner
            </code>
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-mono font-semibold text-muted-foreground shrink-0">
            3.
          </span>
          <span>
            Finish this wizard. You'll get a one-line start command (with
            your runner token) on the dashboard.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-mono font-semibold text-muted-foreground shrink-0">
            4.
          </span>
          <span>
            Run it. The dashboard banner turns green once your runner
            connects — agents start working from that moment.
          </span>
        </li>
      </ol>
      <div className="flex items-start gap-2 rounded border border-border bg-muted/30 p-2.5 text-xs">
        <ShieldCheck
          className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-muted-foreground">
          Your {cliLabel} subscription stays on your laptop. We never see
          your API keys or your provider auth — only the work output you
          allow.
        </span>
      </div>
      <label
        className="flex items-start gap-2 text-xs cursor-pointer"
        data-testid="adapter-validation-ack-label"
      >
        <input
          type="checkbox"
          checked={status.kind === "valid"}
          onChange={(e) => {
            if (e.target.checked) {
              handleConfirmCliInstalled();
            } else {
              setStatus({ kind: "idle" });
              onValidated(false);
            }
          }}
          className="mt-0.5 h-3.5 w-3.5 shrink-0"
          data-testid="adapter-validation-ack-checkbox"
        />
        <span>
          I understand — agents won't run until I install the runner after
          the wizard.
        </span>
      </label>
      {status.kind === "valid" && (
        <div
          className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300"
          data-testid="adapter-validation-status-valid"
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Got it — continue to finish setup.</span>
        </div>
      )}
    </div>
  );
}
