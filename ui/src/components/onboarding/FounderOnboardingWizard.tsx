import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, X } from "lucide-react";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useNavigate } from "@/lib/router";
import { api } from "@/api/client";
import { formatBootstrapError } from "@/lib/onboarding-bootstrap-error";
import { useDialog } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Step1Vision } from "./steps/Step1Vision.js";
import { Step2Bottleneck } from "./steps/Step2Bottleneck.js";
import { Step3Team } from "./steps/Step3Team.js";
import { Step4Plugin, type ValidationState } from "./steps/Step4Plugin.js";
import { Step5Departments } from "./steps/Step5Departments.js";
import { Step5MeetTeam } from "./steps/Step5MeetTeam.js";
import { Step6FirstDecision } from "./steps/Step6FirstDecision.js";
import { Step7Telemetry } from "./steps/Step7Telemetry.js";
import { ProviderChooser, type ProviderOption } from "./ProviderChooser.js";
import {
  buildAutoCharters,
  buildFirstDecisions,
} from "./auto-charter.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  DEFAULT_INTEGRATION_STATE,
  DEFAULT_NON_CORE_DEPARTMENTS,
  type AutonomyLevel,
  type Bottleneck,
  type IntegrationKey,
  type NonCoreDepartmentId,
  type OnboardingBootstrapResponse,
  type OnboardingDraft,
  type TeamShape,
} from "./onboarding-types.js";

// S1.9 — added Step 5 (departments) between Plugin and MeetTeam.
// MeetTeam moved 5 → 6, FirstDecision moved 6 → 7.
// S-TC1 (council 2026-05-05 P1) — added Step 8 (telemetry consent) at the
// END so the founder is asked AFTER seeing the product story. Default OFF.
type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const TOTAL_STEPS = 8;

/**
 * S7.C.1 — Bridge between the chooser's six-tile registry and the
 * legacy three-value `AdapterChoice` enum. The chooser surfaces
 * Claude Code (subscription) and Anthropic API (api_key) as live
 * tiles; both resolve to the existing adapter slots. Coming-soon
 * tiles never call this path — they're disabled at the tile level.
 */
function mapProviderToAdapter(
  option: ProviderOption,
): OnboardingDraft["adapterChoice"] | null {
  if (option.status !== "live") return null;
  if (option.id === "claude_code") return "claude_local";
  if (option.id === "anthropic_api") return "anthropic_api";
  return null;
}

function mapAdapterToProviderId(
  choice: OnboardingDraft["adapterChoice"],
  // anthropicKey is unused today but kept in the signature so a future
  // S7.C.3 patch can disambiguate `claude_local`-with-key from
  // `claude_local`-CLI without an API change.
  _anthropicKey: string,
): string | null {
  if (choice === "claude_local") return "claude_code";
  if (choice === "anthropic_api") return "anthropic_api";
  return null;
}

function buildInitialDraft(): OnboardingDraft {
  return {
    vision: "",
    bottlenecks: [],
    team: "solo",
    cofounderName: "",
    cofounderEmail: "",
    adapterChoice: "claude_local",
    anthropicKey: "",
    integrations: { ...DEFAULT_INTEGRATION_STATE },
    nonCoreDepartments: [...DEFAULT_NON_CORE_DEPARTMENTS],
    autonomyLevel: DEFAULT_AUTONOMY_LEVEL,
    charters: buildAutoCharters({
      vision: "",
      bottlenecks: [],
      team: "solo",
    }),
    firstDecisionId: null,
    // Default OFF — council 2026-05-05 P1. Founder MUST tap "Allow"
    // on Step 8 to flip this on.
    telemetryEnabled: false,
  };
}

export function FounderOnboardingWizard() {
  const { onboardingOpen, closeOnboarding } = useDialog();
  const { setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<OnboardingDraft>(() => buildInitialDraft());
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Server-generated decisions: real Claude call that uses the founder's
  // vision + bottlenecks + team to produce 3 tailored cards. Fetched lazily
  // once the user has reached the meet-team step (step 6 after S1.9 inserted
  // a departments step at 5). Falls back to client-side templates if the
  // fetch is still in flight or errors — we never block the wizard on the
  // LLM round-trip.
  const canFetchDecisions =
    step >= 6 &&
    draft.vision.trim().length >= 10 &&
    draft.bottlenecks.length >= 1;

  const serverDecisionsQuery = useQuery({
    queryKey: [
      "onboarding",
      "first-decisions",
      draft.vision.trim(),
      draft.bottlenecks.join("|"),
      draft.team,
    ],
    enabled: canFetchDecisions,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const res = await api.post<{
        decisions: Array<{ id: string; slot: "cos" | "growth" | "content" | "finance"; title: string; rationale: string }>;
        source: "llm" | "fallback";
      }>("/onboarding/first-decisions", {
        vision: draft.vision.trim(),
        bottlenecks: draft.bottlenecks,
        team: draft.team,
      });
      return res;
    },
  });

  const decisions = useMemo(() => {
    if (serverDecisionsQuery.data?.decisions?.length) {
      return serverDecisionsQuery.data.decisions;
    }
    return buildFirstDecisions(draft.bottlenecks);
  }, [serverDecisionsQuery.data, draft.bottlenecks]);

  // Keep charters in sync whenever inputs that feed them change, but only
  // until the user has manually edited a charter (we detect that via a
  // marker held in local component state). Simplest rule: regenerate when
  // inputs change in steps 1-3; after that user can override freely.
  useEffect(() => {
    if (step > 4) return; // don't stomp edits after the user has seen them
    setDraft((prev) => ({
      ...prev,
      charters: buildAutoCharters({
        vision: prev.vision,
        bottlenecks: prev.bottlenecks,
        team: prev.team,
      }),
    }));
  }, [step, draft.vision, draft.bottlenecks, draft.team]);

  // Reset when the dialog is closed externally.
  useEffect(() => {
    if (!onboardingOpen) {
      setStep(1);
      setDraft(buildInitialDraft());
      setValidation({ status: "idle" });
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [onboardingOpen]);

  function patchDraft(patch: Partial<OnboardingDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function canAdvance(current: Step): boolean {
    if (current === 1) return draft.vision.trim().length >= 10;
    if (current === 2) return draft.bottlenecks.length >= 1;
    if (current === 3) return true;
    if (current === 4) {
      // claude_local + skip don't require a validated key; only anthropic_api does.
      if (draft.adapterChoice === "claude_local" || draft.adapterChoice === "skip") return true;
      // Live debounced validation surfaces "valid" on a healthy key, or
      // "skipped" when the user opts past a transport/rate-limit
      // failure. Both unblock Next; bootstrap will re-validate at
      // submit-time as belt-and-suspenders.
      return validation.status === "valid" || validation.status === "skipped";
    }
    if (current === 5) return true; // Departments — core 5 are always-on, no further gate
    if (current === 6) return true;
    if (current === 7) return true;
    if (current === 8) return true; // Telemetry consent — both Yes and No are valid answers
    return false;
  }

  async function handleFinish() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        vision: draft.vision.trim(),
        bottlenecks: draft.bottlenecks,
        team: draft.team,
        cofounder:
          draft.cofounderName.trim() || draft.cofounderEmail.trim()
            ? {
                name: draft.cofounderName.trim() || null,
                email: draft.cofounderEmail.trim() || null,
              }
            : null,
        adapterChoice: draft.adapterChoice,
        anthropicKey: draft.adapterChoice === "anthropic_api" ? draft.anthropicKey : "",
        integrations: draft.integrations,
        nonCoreDepartments: draft.nonCoreDepartments,
        autonomyLevel: draft.autonomyLevel,
        charters: draft.charters,
        // S-TC1 — telemetry consent decision from the final wizard step.
        // Always present (true OR false) — the wizard cannot complete
        // without the founder having seen Step 8.
        telemetryEnabled: draft.telemetryEnabled,
      };
      const bootstrap = await api.post<OnboardingBootstrapResponse>(
        "/onboarding/bootstrap",
        payload,
      );
      if (draft.firstDecisionId) {
        const decision = decisions.find((d) => d.id === draft.firstDecisionId);
        if (decision) {
          await api.post("/onboarding/accept-decision", {
            companyId: bootstrap.companyId,
            decision: {
              id: decision.id,
              slot: decision.slot,
              title: decision.title,
              rationale: decision.rationale,
            },
            agentIdsBySlot: bootstrap.agentIdsBySlot,
            goalId: bootstrap.goalId,
            projectId: bootstrap.projectId,
          }).catch((err) => {
            // Non-fatal — surface but don't block the redirect.
            // eslint-disable-next-line no-console
            console.warn("Failed to stage first decision", err);
          });
        }
      }

      setSelectedCompanyId(bootstrap.companyId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      closeOnboarding();
      const prefix = bootstrap.companyPrefix;
      navigate(
        draft.firstDecisionId
          ? `/${prefix}/decisions?first=${encodeURIComponent(draft.firstDecisionId)}`
          : `/${prefix}/dashboard`,
      );
    } catch (err) {
      // PR-8 / P1-E2 — preserve HTTP status semantics + requestId in the
      // error string. See ui/src/lib/onboarding-bootstrap-error.ts for
      // the status-aware headlines and the "Reference: <id>" footer.
      setSubmitError(formatBootstrapError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!onboardingOpen) return null;

  const progressPercent = ((step - 1) / (TOTAL_STEPS - 1)) * 100;

  return (
    <Dialog
      open={onboardingOpen}
      onOpenChange={(open) => {
        if (!open) closeOnboarding();
      }}
    >
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-background" />
        <div
          className="fixed inset-0 z-50 flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Founder onboarding wizard"
          data-testid="onboarding-wizard"
        >
          {/* Progress bar */}
          <div className="shrink-0 border-b border-border/60 px-6 py-3">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {step > 1 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => (s - 1) as Step)}
                    disabled={submitting}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                  </button>
                ) : (
                  <span className="w-12" />
                )}
                <p className="text-xs text-muted-foreground">
                  Step {step} of {TOTAL_STEPS}
                </p>
              </div>
              <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
                <div
                  className="absolute inset-y-0 left-0 bg-foreground transition-[width] duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => closeOnboarding()}
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close onboarding"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-6 py-10">
              {step === 1 && (
                <Step1Vision
                  vision={draft.vision}
                  onVisionChange={(v) => patchDraft({ vision: v })}
                />
              )}
              {step === 2 && (
                <Step2Bottleneck
                  selected={draft.bottlenecks}
                  onChange={(next: Bottleneck[]) =>
                    patchDraft({ bottlenecks: next })
                  }
                />
              )}
              {step === 3 && (
                <Step3Team
                  team={draft.team}
                  cofounderName={draft.cofounderName}
                  cofounderEmail={draft.cofounderEmail}
                  onTeamChange={(t: TeamShape) => patchDraft({ team: t })}
                  onCofounderNameChange={(v) =>
                    patchDraft({ cofounderName: v })
                  }
                  onCofounderEmailChange={(v) =>
                    patchDraft({ cofounderEmail: v })
                  }
                />
              )}
              {step === 4 && (
                <div className="space-y-8">
                  {/*
                    S7.C.1 — Multi-provider chooser inserted ahead of the
                    legacy adapter list. Six tiles, two live; selection
                    drives the same `adapterChoice` slot Step4Plugin
                    already manages so existing key validation + bootstrap
                    pipeline keeps working unchanged.

                    The `Step4Plugin` block below stays in place for now:
                    its inline key field will be replaced by S7.C.2's
                    drawer in the next ticket. The integrations toggles
                    inside Step4Plugin remain in scope here (only the
                    adapter selection migrates to the chooser).
                  */}
                  <ProviderChooser
                    selectedId={mapAdapterToProviderId(
                      draft.adapterChoice,
                      draft.anthropicKey,
                    )}
                    onSelect={(option) => {
                      const nextChoice = mapProviderToAdapter(option);
                      if (nextChoice === null) return;
                      patchDraft({ adapterChoice: nextChoice });
                      // Switching tile clears any in-flight key validation
                      // so the founder re-enters credentials for the new
                      // option. Mirrors Step4Plugin's existing behaviour.
                      if (nextChoice !== "anthropic_api") {
                        setValidation({ status: "idle" });
                      }
                    }}
                  />
                  <Step4Plugin
                    adapterChoice={draft.adapterChoice}
                    anthropicKey={draft.anthropicKey}
                    integrations={draft.integrations}
                    validation={validation}
                    onAdapterChoiceChange={(choice) =>
                      patchDraft({ adapterChoice: choice })
                    }
                    onAnthropicKeyChange={(key) =>
                      patchDraft({ anthropicKey: key })
                    }
                    onIntegrationsChange={(
                      next: Record<IntegrationKey, boolean>,
                    ) => patchDraft({ integrations: next })}
                    onValidationChange={setValidation}
                  />
                </div>
              )}
              {step === 5 && (
                <Step5Departments
                  nonCoreDepartments={draft.nonCoreDepartments}
                  autonomyLevel={draft.autonomyLevel}
                  onNonCoreDepartmentsChange={(next: NonCoreDepartmentId[]) =>
                    patchDraft({ nonCoreDepartments: next })
                  }
                  onAutonomyLevelChange={(next: AutonomyLevel) =>
                    patchDraft({ autonomyLevel: next })
                  }
                />
              )}
              {step === 6 && (
                <Step5MeetTeam
                  charters={draft.charters}
                  onChartersChange={(c) => patchDraft({ charters: c })}
                />
              )}
              {step === 7 && (
                <Step6FirstDecision
                  decisions={decisions}
                  charters={draft.charters}
                  selectedId={draft.firstDecisionId}
                  onSelect={(id) => patchDraft({ firstDecisionId: id })}
                />
              )}
              {step === 8 && (
                <Step7Telemetry
                  telemetryEnabled={draft.telemetryEnabled}
                  onTelemetryEnabledChange={(next) =>
                    patchDraft({ telemetryEnabled: next })
                  }
                />
              )}
              {submitError && (
                <p className="mt-6 text-xs text-destructive">{submitError}</p>
              )}
            </div>
          </div>

          {/* Footer — primary action */}
          <div className="shrink-0 border-t border-border/60 px-6 py-4">
            <div className="mx-auto flex max-w-2xl items-center justify-end">
              {step < TOTAL_STEPS ? (
                <Button
                  size="sm"
                  disabled={!canAdvance(step)}
                  onClick={() => setStep((s) => (s + 1) as Step)}
                  className={cn(!canAdvance(step) && "opacity-50")}
                >
                  Next
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={submitting}
                  onClick={() => void handleFinish()}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Launching...
                    </>
                  ) : draft.firstDecisionId ? (
                    "Launch + start first decision"
                  ) : (
                    "Launch FounderOS"
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
