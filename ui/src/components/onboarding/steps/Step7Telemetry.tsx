import { Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * S-TC1 — Telemetry consent step. Council 2026-05-05 P1 fix: the landing
 * page promises "no telemetry unless you flip it on", but the prior
 * defaults shipped telemetry ON for every fresh install. This step is
 * the explicit opt-in surface — it appears at the END of the onboarding
 * wizard so the founder has already seen the product story before being
 * asked.
 *
 * The default is "Keep it off" (unchecked). The wizard cannot infer
 * consent — the founder MUST tap "Allow" to flip it on.
 */

interface Props {
  telemetryEnabled: boolean;
  onTelemetryEnabledChange: (next: boolean) => void;
}

const EVENT_TYPES: Array<{ id: string; label: string; example: string }> = [
  { id: "install", label: "Install", example: "install.started, install.completed" },
  { id: "company", label: "Company", example: "company.imported (source ref hashed if private)" },
  { id: "agent", label: "Agent", example: "agent.created, agent.first_heartbeat, agent.task_completed" },
  { id: "routine", label: "Cadence", example: "routine.created, routine.run" },
  { id: "errors", label: "Errors", example: "error.handler_crash (error code only, no stack)" },
];

const TELEMETRY_ENDPOINT = "https://telemetry.founderos.ai/ingest";
const RETENTION = "Aggregated counters retained 90 days; raw events purged after 30 days.";

export function Step7Telemetry({ telemetryEnabled, onTelemetryEnabledChange }: Props) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Anonymous usage telemetry?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Off by default. Flip it on if you want to help us see which agents and
          cadences actually get used. Never shares your code, your founder data,
          or your customer data — only counters and event names.
        </p>
      </div>

      <section
        aria-labelledby="telemetry-options-heading"
        className="space-y-3"
      >
        <h3
          id="telemetry-options-heading"
          className="text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          Your choice
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            data-testid="telemetry-keep-off"
            onClick={() => onTelemetryEnabledChange(false)}
            className={cn(
              "rounded-lg border bg-transparent px-4 py-4 text-left transition-colors",
              !telemetryEnabled
                ? "border-foreground bg-accent/30"
                : "border-border hover:bg-accent/20",
            )}
          >
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Keep it off (default)</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  Nothing leaves this host. You can flip this on later in
                  Settings.
                </p>
              </div>
            </div>
          </button>
          <button
            type="button"
            data-testid="telemetry-allow"
            onClick={() => onTelemetryEnabledChange(true)}
            className={cn(
              "rounded-lg border bg-transparent px-4 py-4 text-left transition-colors",
              telemetryEnabled
                ? "border-foreground bg-accent/30"
                : "border-border hover:bg-accent/20",
            )}
          >
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Allow anonymous telemetry</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  Counters and event names only. No code, no agent prompts, no
                  founder/customer data.
                </p>
              </div>
            </div>
          </button>
        </div>
      </section>

      <section
        aria-labelledby="telemetry-disclosure-heading"
        className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-4"
      >
        <h3
          id="telemetry-disclosure-heading"
          className="text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          What gets sent if you flip it on
        </h3>
        <dl className="grid grid-cols-1 gap-2 text-xs">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="w-32 shrink-0 font-medium">Endpoint</dt>
            <dd className="text-muted-foreground break-all">
              {TELEMETRY_ENDPOINT}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="w-32 shrink-0 font-medium">Identifier</dt>
            <dd className="text-muted-foreground">
              Random install ID (UUID) — not tied to your email or any user
              account.
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="w-32 shrink-0 font-medium">Retention</dt>
            <dd className="text-muted-foreground">{RETENTION}</dd>
          </div>
        </dl>
        <div className="space-y-1">
          <p className="text-xs font-medium">Event categories</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {EVENT_TYPES.map((type) => (
              <li key={type.id} className="leading-snug">
                <span className="font-medium text-foreground">
                  {type.label}:
                </span>{" "}
                {type.example}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">
          You can flip this off anytime in Settings · General. Any event that
          might leak a private repo/company name is hashed before it's sent.
        </p>
      </section>
    </div>
  );
}
