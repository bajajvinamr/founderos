import { useEffect, useMemo, useRef, useState } from "react";
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
import { useDisplay } from "@/lib/use-display";
import { Step1Vision } from "./steps/Step1Vision.js";
import { Step2Bottleneck } from "./steps/Step2Bottleneck.js";
import { Step3Team } from "./steps/Step3Team.js";
import { Step5Departments } from "./steps/Step5Departments.js";
import { Step5MeetTeam } from "./steps/Step5MeetTeam.js";
import { Step6FirstDecision } from "./steps/Step6FirstDecision.js";
import { Step7Telemetry } from "./steps/Step7Telemetry.js";
import { ProviderChooser, type ProviderOption } from "./ProviderChooser.js";
import { AdapterValidationPanel } from "./AdapterValidationPanel.js";
import {
  buildAutoCharters,
  buildFirstDecisions,
} from "./auto-charter.js";
import {
  DEFAULT_AUTONOMY_LEVEL,
  DEFAULT_INTEGRATION_STATE,
  DEFAULT_NON_CORE_DEPARTMENTS,
  INTEGRATION_KEYS,
  INTEGRATION_LABELS,
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
 * S7.C.1 (fix: PR provider-routing) — Bridge between the chooser's six-tile
 * registry and the canonical `OnboardingAdapterChoice` enum.
 *
 * Previously only `claude_code` and `anthropic_api` had non-null mappings;
 * the four remaining live tiles (`gemini_cli`, `google_api`, `codex_cli`,
 * `openai_api`) returned null, causing the click handler's early-return guard
 * (`if (nextChoice === null) return;`) to silently swallow the selection.
 * The draft retained its default `adapterChoice: "anthropic_api"` regardless
 * of what the founder clicked — confirmed by three independent audits.
 *
 * This patch maps every live tile ID to its canonical adapter choice so
 * `patchDraft` is called on all six tiles. Tile IDs match the `id` field in
 * `ProviderChooser.PROVIDER_OPTIONS`; canonical choice values are the
 * `ONBOARDING_ADAPTER_CHOICES` from `@founderos/shared`.
 *
 * Note: `google_api` is accepted here (tile is live) but throws a clear
 * "not yet implemented" error on the server (S7 Phase 4). The founder
 * sees a proper bootstrap error rather than a silent wrong-provider boot.
 */
/** @internal Exported for unit testing — not part of the public component API. */
export function mapProviderToAdapter(
  option: ProviderOption,
): OnboardingDraft["adapterChoice"] | null {
  if (option.status !== "live") return null;
  switch (option.id) {
    case "claude_code":   return "claude_local";
    case "anthropic_api": return "anthropic_api";
    case "gemini_cli":    return "gemini_local";
    case "google_api":    return "google_api";
    case "codex_cli":     return "codex_local";
    case "openai_api":    return "openai_api";
    default:              return null;
  }
}

/** @internal Exported for unit testing — not part of the public component API. */
export function mapAdapterToProviderId(
  choice: OnboardingDraft["adapterChoice"],
  // anthropicKey is unused today but kept in the signature so a future
  // S7.C.3 patch can disambiguate `claude_local`-with-key from
  // `claude_local`-CLI without an API change.
  _anthropicKey: string,
): string | null {
  // BL-004 — `choice` is null on first paint of Step 4 (no tile selected
  // yet). ProviderChooser renders no aria-pressed tile in that state.
  if (choice === null) return null;
  switch (choice) {
    case "claude_local":  return "claude_code";
    case "anthropic_api": return "anthropic_api";
    case "gemini_local":  return "gemini_cli";
    case "google_api":    return "google_api";
    case "codex_local":   return "codex_cli";
    case "openai_api":    return "openai_api";
    default:              return null;
  }
}

/**
 * Build the bootstrap POST payload from the wizard's draft state.
 *
 * Extracted as a pure function (and exported as `@internal`) so the
 * api-key-passing contract has a regression test independent of the
 * wizard's render tree. See `__tests__/bootstrap-payload.test.ts`.
 *
 * **Critical invariant (2026-05-18):** for any api-mode adapter family
 * — `anthropic_api`, `openai_api`, `google_api` — the function MUST
 * send `anthropicKey` populated with `draft.anthropicKey`. Prior to
 * this fix, the wizard sent `""` for non-anthropic api families, which
 * broke OpenAI and Google onboarding end-to-end (server rejected with
 * `unprocessable: API key is required when adapterChoice is 'openai_api'`).
 *
 * The field is named `anthropicKey` for historical reasons; rename to
 * `apiKey` is a follow-up that touches the server Zod schema too.
 *
 * @internal Exported for unit testing — not part of the public component API.
 */
export function buildBootstrapPayload(
  draft: OnboardingDraft,
  adapterChoice: NonNullable<OnboardingDraft["adapterChoice"]>,
) {
  return {
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
    adapterChoice,
    anthropicKey:
      adapterChoice === "anthropic_api" ||
      adapterChoice === "openai_api" ||
      adapterChoice === "google_api"
        ? draft.anthropicKey
        : "",
    integrations: draft.integrations,
    nonCoreDepartments: draft.nonCoreDepartments,
    autonomyLevel: draft.autonomyLevel,
    charters: draft.charters,
    // S-TC1 — telemetry consent from Step 8 (cannot complete without seeing it).
    telemetryEnabled: draft.telemetryEnabled,
  };
}

function buildInitialDraft(): OnboardingDraft {
  return {
    vision: "",
    bottlenecks: [],
    team: "solo",
    cofounderName: "",
    cofounderEmail: "",
    // BL-004 (P2.c, audit finding) — null until the founder explicitly
    // clicks a tile. The prior default of "anthropic_api" biased analytics
    // ("most founders pick Anthropic" — they didn't, the tile was just
    // pre-selected). Removing the default forces an honest choice; Step 4's
    // Continue button is gated on `canAdvance(4)` rejecting null below.
    adapterChoice: null,
    anthropicKey: "",
    // Step 4 advance-gate (2026-05-12) — both fields stay null/false
    // until the founder validates their chosen adapter. See
    // `AdapterValidationPanel` and `canAdvance(4)` below.
    adapterValidated: false,
    validatedFor: null,
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // BL-002 (P2.a, founder-language sweep) — Step 4 H1 + subtitle are now
  // driven by the DisplayDictionary so they switch between founder and
  // engineer voice based on `founderos.viewMode` in localStorage. The keys
  // live in `packages/shared/src/display-dictionary.ts`; the hook reads
  // viewMode + returns the active label.
  const step4Headline = useDisplay("onboarding.step4.headline");
  const step4Subtitle = useDisplay("onboarding.step4.subtitle");

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

  // Council P2 (2026-05-19) — draft hydration from server-persisted state.
  // `hydratedRef` gates the debounced save effect below so we don't echo
  // server state back to the server during the hydration window (avoids a
  // pointless round-trip and a potential race where a stale local default
  // overwrites freshly-hydrated state).
  //
  // Lifecycle:
  //   - onboardingOpen flips true → GET /onboarding/draft, hydrate state,
  //     mark hydrated; save effect now active.
  //   - User patches draft → debounced PUT after 800ms quiet period.
  //   - handleFinish() → POST /onboarding/draft/complete after bootstrap;
  //     server flips completed_at so the next GET creates a fresh draft.
  //   - onboardingOpen flips false → mark un-hydrated; on next open we
  //     hydrate again. Local state is NOT reset (server is the source of
  //     truth). If user explicitly cancels via the close-confirm, their
  //     state still lives server-side and resumes on the next open.
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hydrating, setHydrating] = useState(false);

  useEffect(() => {
    if (!onboardingOpen) {
      // Cancel any in-flight save timer on close.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      hydratedRef.current = false;
      return;
    }

    // Hydration: GET the user's in-progress draft (server `getOrCreate`
    // returns an empty draft if none exists, so this is idempotent).
    let cancelled = false;
    setHydrating(true);
    void api
      .get<{
        id: string;
        currentStep: number;
        draft: Partial<OnboardingDraft>;
        completedAt: string | null;
      }>("/onboarding/draft")
      .then((server) => {
        if (cancelled) return;
        // Merge server draft over current defaults. Spread-merge tolerates
        // a server-side draft written by an older wizard version (missing
        // fields fall through to defaults).
        setDraft((prev) => ({ ...prev, ...(server.draft as Partial<OnboardingDraft>) }));
        // Clamp to valid Step union — server stores int 1..8, but defense
        // against drift if MAX changes on either side.
        const clamped = Math.min(
          Math.max(1, server.currentStep || 1),
          TOTAL_STEPS,
        ) as Step;
        setStep(clamped);
      })
      .catch(() => {
        // Non-fatal — wizard continues with default state. The debounced
        // save below will retry on next patchDraft.
      })
      .finally(() => {
        if (cancelled) return;
        setHydrating(false);
        hydratedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, [onboardingOpen]);

  // Debounced save: PUT the draft 800ms after the last change. Flushes
  // on close (cleanup in the hydration effect cancels the timer; the
  // server keeps the last successful save).
  useEffect(() => {
    if (!onboardingOpen || !hydratedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void api
        .put("/onboarding/draft", {
          currentStep: step,
          draft,
        })
        .catch(() => {
          // Non-fatal — next change re-schedules. We deliberately do not
          // surface this to the user; the close-confirm and the final
          // handleFinish bootstrap are the load-bearing failure surfaces.
        });
    }, 800);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [step, draft, onboardingOpen]);

  function patchDraft(patch: Partial<OnboardingDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  /**
   * Heuristic: does the founder have enough state in the wizard that
   * a stray Esc/click-outside would feel like a loss? Used only to gate
   * the close confirm — we deliberately do NOT trigger on a few chars
   * typed into vision.
   *
   * As of 2026-05-19 the wizard hydrates from server-persisted state
   * (Council P2 fix above), so closing no longer loses work — the next
   * open resumes from the same step. The confirm dialog remains as a
   * UX backstop against accidental close, with copy that reflects the
   * new persistence contract.
   */
  function hasMeaningfulDraftState(): boolean {
    return (
      draft.vision.trim().length >= 10 ||
      draft.bottlenecks.length > 0 ||
      draft.adapterChoice !== null ||
      draft.cofounderName.trim().length > 0 ||
      draft.cofounderEmail.trim().length > 0
    );
  }

  function handleCloseRequest() {
    if (submitting) return; // never close mid-submit
    if (hasMeaningfulDraftState()) {
      const ok = window.confirm(
        "Close onboarding? Your progress is saved — you can resume anytime.",
      );
      if (!ok) return;
    }
    closeOnboarding();
  }

  function canAdvance(current: Step): boolean {
    if (current === 1) return draft.vision.trim().length >= 10;
    if (current === 2) return draft.bottlenecks.length >= 1;
    if (current === 3) return true;
    // BL-004 — Step 4 (provider chooser) requires an explicit tile click.
    // Default is null; Continue stays disabled until the founder picks.
    // 2026-05-12 — gate also requires the founder to validate the chosen
    // adapter. `validatedFor === adapterChoice` defends against a race
    // where the founder validates tile A then switches to tile B.
    if (current === 4) {
      return (
        draft.adapterChoice !== null &&
        draft.adapterValidated &&
        draft.validatedFor === draft.adapterChoice
      );
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
    // BL-004 — Step 4's `canAdvance` gate enforces non-null adapterChoice
    // before the wizard reaches Step 8. This is a defense-in-depth check:
    // if the user somehow lands here with no choice, fail fast rather than
    // POST null to the server's Zod validator (which would 400 anyway).
    if (draft.adapterChoice === null) {
      setSubmitError("Please choose an AI provider on Step 4 before launching.");
      setSubmitting(false);
      return;
    }
    // 2026-05-12 — defense in depth: Step 4's canAdvance() already
    // refuses to advance without validation, but reject again here in
    // case the validation gate was bypassed via stale state.
    if (
      !draft.adapterValidated ||
      draft.validatedFor !== draft.adapterChoice
    ) {
      setSubmitError(
        "Please validate your AI provider on Step 4 before launching.",
      );
      setSubmitting(false);
      return;
    }
    const adapterChoice = draft.adapterChoice;
    try {
      const payload = buildBootstrapPayload(draft, adapterChoice);
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

      // Mark the draft completed server-side so the next GET creates a
      // fresh draft (vs. resuming this one). Non-blocking — bootstrap
      // success is the load-bearing signal; if /complete fails the next
      // wizard mount will hydrate the now-stale draft which is mildly
      // confusing but recoverable (user can just dismiss + restart).
      void api.post("/onboarding/draft/complete", {}).catch(() => {
        /* non-fatal — bootstrap already succeeded */
      });

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
        // 2026-05-18 — accidental close guard. Esc / click-outside both
        // go through this path; we route to handleCloseRequest so the
        // confirm-on-meaningful-state contract applies uniformly.
        if (!open) handleCloseRequest();
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
                onClick={handleCloseRequest}
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close onboarding"
                data-testid="onboarding-close-button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-6 py-10">
              {hydrating ? (
                <div
                  className="flex items-center justify-center py-20 text-sm text-muted-foreground"
                  data-testid="onboarding-hydrating"
                >
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading your progress…
                </div>
              ) : (
              <>
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
                  <div>
                    <h2
                      className="text-2xl font-semibold tracking-tight"
                      data-testid="onboarding-step4-headline"
                    >
                      {step4Headline}
                    </h2>
                    <p
                      className="mt-2 text-sm text-muted-foreground"
                      data-testid="onboarding-step4-subtitle"
                    >
                      {step4Subtitle}
                    </p>
                  </div>

                  {/* Provider chooser — six tiles, two live */}
                  <ProviderChooser
                    selectedId={mapAdapterToProviderId(
                      draft.adapterChoice,
                      draft.anthropicKey,
                    )}
                    onSelect={(option) => {
                      const nextChoice = mapProviderToAdapter(option);
                      if (nextChoice === null) return;
                      // 2026-05-12 — switching tiles ALWAYS resets the
                      // validation gate, even if the founder lands back
                      // on the same tile (`patchDraft` is a no-op on
                      // unchanged fields, so re-selecting is harmless).
                      patchDraft({
                        adapterChoice: nextChoice,
                        adapterValidated: false,
                        validatedFor: null,
                      });
                    }}
                  />

                  {draft.adapterChoice !== null && (
                    <AdapterValidationPanel
                      adapterChoice={draft.adapterChoice}
                      apiKey={draft.anthropicKey}
                      onApiKeyChange={(next) =>
                        patchDraft({ anthropicKey: next })
                      }
                      validated={
                        draft.adapterValidated &&
                        draft.validatedFor === draft.adapterChoice
                      }
                      onValidated={(next) =>
                        patchDraft({
                          adapterValidated: next,
                          validatedFor: next ? draft.adapterChoice : null,
                        })
                      }
                    />
                  )}

                  {/* Integrations toggles */}
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                      Integrations (optional)
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {INTEGRATION_KEYS.map((key) => {
                        const enabled = draft.integrations[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => {
                              patchDraft({
                                integrations: {
                                  ...draft.integrations,
                                  [key]: !draft.integrations[key],
                                },
                              });
                            }}
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
              </>
              )}
            </div>
          </div>

          {/* Footer — primary action */}
          <div className="shrink-0 border-t border-border/60 px-6 py-4">
            <div className="mx-auto flex max-w-2xl items-center justify-end">
              {step < TOTAL_STEPS ? (
                <Button
                  size="sm"
                  disabled={hydrating || !canAdvance(step)}
                  onClick={() => setStep((s) => (s + 1) as Step)}
                  className={cn((hydrating || !canAdvance(step)) && "opacity-50")}
                >
                  Next
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={hydrating || submitting}
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
