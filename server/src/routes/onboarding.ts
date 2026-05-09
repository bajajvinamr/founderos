/**
 * Founder-native onboarding (Wave 15A) — opinionated 6-step flow.
 *
 * The new UI wizard hits these endpoints instead of stitching together
 * companies + agents + goals + issues itself. This route owns the whole
 * bootstrap transaction so a half-finished onboarding never leaves
 * orphan rows in the database.
 *
 * Endpoints:
 *   POST /api/onboarding/bootstrap
 *     - Creates company, ensures membership, saves Anthropic key as a
 *       company secret, seeds four agents (CoS, Growth, Content,
 *       Finance) with the user-edited charters, and stages the default
 *       "Onboarding" project + company goal.
 *   POST /api/onboarding/first-decisions
 *     - Returns three templated first-decision cards for a given set of
 *       bottlenecks. Pure function today; a later revision will call
 *       Claude server-side with the vision + bottleneck.
 *   POST /api/onboarding/accept-decision
 *     - Inserts the chosen decision into the Decision Inbox as a
 *       pre-approved issue routed to the owning agent.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  ONBOARDING_ADAPTER_AUTH_MODES,
  ONBOARDING_ADAPTER_CHOICES,
} from "@founderos/shared";
import { authUsers, instanceUserRoles, type Db } from "@founderos/db";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { onboardingBootstrapLimiter } from "../middleware/rate-limit.js";
import { requireCompanyAccess } from "../middleware/require-company-access.js";
import { assertBoard } from "./authz.js";
import { logger } from "../middleware/logger.js";
import {
  instanceSettingsService,
  issueService,
  logActivity,
  validateAnthropicKey,
} from "../services/index.js";
import { subscriptionService } from "../services/subscription.js";
import {
  AGENT_SLOTS,
  ANALYTICS_INTEGRATION_KEYS,
  bootstrapCompanyOnboarding,
  type BootstrapInput,
} from "../services/onboarding-bootstrap.js";
import { generateFirstDecisions } from "../services/onboarding-decisions.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const DEFAULT_COMPANY_NAME = "My Company";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const slotSchema = z.enum(AGENT_SLOTS);

const charterSchema = z.object({
  slot: slotSchema,
  name: z.string().min(1).max(120),
  title: z.string().min(1).max(80),
  avatar: z.string().max(16).optional().default(""),
  charter: z.string().min(1).max(2000),
  firstPriority: z.string().min(1).max(500),
});

const bootstrapSchema = z.object({
  vision: z.string().min(10).max(4000),
  bottlenecks: z.array(z.string().min(1)).min(1).max(2),
  team: z.enum(["solo", "cofounder", "small_team"]),
  cofounder: z
    .object({
      name: z.string().nullable(),
      email: z.string().email().nullable(),
    })
    .nullable()
    .optional(),
  // S7.0.2 (multi-CLI runner sprint, 2026-05-07) — widened from the
  // Claude-only triplet to all 7 CLI choices + anthropic_api + skip.
  // Canonical list lives in `@founderos/shared` and mirrors
  // `ADAPTER_CHOICES` in `ui/src/components/onboarding/onboarding-types.ts`.
  // Only `anthropic_api` triggers the live key validation below; all CLI
  // choices skip the key gate. See onboarding-bootstrap.ts for how the
  // choice maps to the actual `agents.adapter_type` value (S7.2 reverses
  // the byo_runner collapse so the user's CLI pick is preserved).
  adapterChoice: z.enum(ONBOARDING_ADAPTER_CHOICES).optional().default("anthropic_api"),
  anthropicKey: z.string().default(""),
  integrations: z.record(z.boolean()).optional().default({}),
  // S1.9 — only NON-core departments are passed; the 5 core (chief-of-staff,
  // growth, content, crm, finance) are always provisioned by business rule.
  nonCoreDepartments: z
    .array(z.enum(["engineering", "ops"]))
    .optional()
    .default([]),
  autonomyLevel: z.number().int().min(1).max(4).optional().default(2),
  charters: z.object({
    cos: charterSchema,
    growth: charterSchema,
    content: charterSchema,
    finance: charterSchema,
  }),
  companyName: z.string().min(1).max(120).optional(),
  // S-TC1 (council 2026-05-05 P1) — explicit telemetry consent decision
  // from the final wizard step. Optional for backwards compatibility with
  // older clients (e.g. CI smoke tests); when omitted, defaults to false
  // (do NOT enable telemetry without explicit consent — that's the whole
  // point of this fix).
  telemetryEnabled: z.boolean().optional().default(false),
});

const firstDecisionsSchema = z.object({
  vision: z.string().min(1).max(2000),
  bottlenecks: z.array(z.string().min(1)).min(1).max(2),
  team: z.enum(["solo", "with_cofounder", "with_team"]),
  companyName: z.string().min(1).max(140).optional(),
});

const acceptDecisionSchema = z.object({
  companyId: z.string().uuid(),
  decision: z.object({
    id: z.string().min(1),
    slot: slotSchema,
    title: z.string().min(1).max(200),
    rationale: z.string().min(1).max(1000),
  }),
  agentIdsBySlot: z.object({
    cos: z.string().uuid(),
    growth: z.string().uuid(),
    content: z.string().uuid(),
    finance: z.string().uuid(),
  }),
  goalId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveCompanyNameFromVision(vision: string): string {
  const trimmed = vision.trim();
  if (!trimmed) return DEFAULT_COMPANY_NAME;
  // First 5 words, capped at 40 chars. Crude but deterministic.
  const words = trimmed.split(/\s+/).slice(0, 5).join(" ");
  return words.length > 40 ? words.slice(0, 40) : words;
}

/**
 * Return the templated first-decision cards for a primary bottleneck.
 * Kept server-side so a later revision can swap in an LLM call without
 * touching the client contract.
 */
function buildServerFirstDecisions(bottlenecks: string[]) {
  const primary = bottlenecks[0] ?? "";
  // The UI has its own (richer) copy of these so the "Meet your team"
  // step can render before any network round-trip. This mirror exists
  // so the server can return authoritative cards once we start scoring
  // them per-company.
  switch (primary) {
    case "pmf":
      return [
        {
          id: "pmf_interviews",
          slot: "growth" as const,
          title: "Run a 5-customer interview sprint this week",
          rationale:
            "Five 30-minute calls, one write-up. Separate 'would pay' from 'polite nods'.",
        },
        {
          id: "pmf_landing",
          slot: "growth" as const,
          title: "Launch a landing-page A/B test",
          rationale:
            "Two headlines, one offer. See which promise actually converts.",
        },
        {
          id: "pmf_insights_post",
          slot: "content" as const,
          title: "Publish an 'insight post' from your interviews",
          rationale: "Turn raw interview patterns into a public artefact.",
        },
      ];
    case "growth":
      return [
        {
          id: "growth_channel_test",
          slot: "growth" as const,
          title: "Pick one channel, ship an experiment by Friday",
          rationale: "One channel, one offer, one week.",
        },
        {
          id: "growth_cold_email",
          slot: "growth" as const,
          title: "Draft a cold-email campaign to 50 ICP founders",
          rationale: "Hand-written, not templated.",
        },
        {
          id: "growth_launch_post",
          slot: "content" as const,
          title: "Write a launch post paired to the first experiment",
          rationale: "Every experiment ships with a story.",
        },
      ];
    default:
      return [
        {
          id: "default_interviews",
          slot: "growth" as const,
          title: "Run a 5-customer interview sprint this week",
          rationale: "Signal first, everything else second.",
        },
        {
          id: "default_narrative",
          slot: "content" as const,
          title: "Draft a one-page narrative for what you're building",
          rationale: "Writes down the story in one voice.",
        },
        {
          id: "default_runway",
          slot: "finance" as const,
          title: "Produce the first runway snapshot",
          rationale: "Five numbers, updated weekly.",
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function onboardingRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);
  // S-TC1 — used to persist the founder's telemetry consent decision into
  // instance_settings.general.telemetryConsent. Operates on the same
  // singleton row that the /settings/general admin toggle reads/writes,
  // so the wizard answer and the admin UI stay in sync.
  const settings = instanceSettingsService(db);

  /**
   * POST /api/onboarding/bootstrap
   *
   * Creates the full starter company in one call. The persistent steps
   * (company, membership, secret, goal, project, memory, agents, audit
   * log) run inside one `db.transaction` via `bootstrapCompanyOnboarding`,
   * so a failure on agent N does not leave behind an orphan company.
   *
   * The Anthropic key live-API check stays here — external network I/O
   * has no place inside a database transaction.
   */
  router.post(
    "/onboarding/bootstrap",
    onboardingBootstrapLimiter,
    validate(bootstrapSchema),
    async (req, res) => {
      assertBoard(req);
      // SaaS path: any authenticated board user may complete onboarding.
      // The bootstrap transaction creates a new company and owner membership
      // for this user, so requiring global instance-admin here dead-ends every
      // normal customer signup once the hosted instance already has an admin.

      const input = req.body as z.infer<typeof bootstrapSchema>;

      // S7.0.2 — auth_mode discriminator gates the API-key requirement.
      // Only `auth_mode === 'api'` choices require a key field; CLI
      // choices (claude_local + the rest of the *_local family) and
      // `skip` (auth_mode='none') bypass the gate entirely. This keeps
      // the load-bearing CLAUDE.md invariant intact: "Adapter choice on
      // onboarding: claude_local + skip don't need an API key."
      //
      // Live API validation is only wired for `anthropic_api` today —
      // the OpenAI and Google validators land with their respective
      // S7.B tiles. Until then, the gate enforces a minimum-length
      // string check so a paste-failure or empty submission is
      // rejected before the bootstrap transaction starts.
      const authMode = ONBOARDING_ADAPTER_AUTH_MODES[input.adapterChoice];
      if (authMode === "api") {
        if (!input.anthropicKey || input.anthropicKey.length < 10) {
          throw unprocessable(
            `API key is required when adapterChoice is '${input.adapterChoice}'`,
          );
        }
        if (input.adapterChoice === "anthropic_api") {
          const keyCheck = await validateAnthropicKey(input.anthropicKey);
          if (!keyCheck.valid) {
            throw unprocessable(
              `Anthropic API key rejected: ${keyCheck.reason ?? "unknown"}`,
            );
          }
        }
        // openai_api / google_api: live validation lands with the
        // respective S7.B tiles; for now the length check above is the
        // backstop and the runtime adapter will surface a clear error
        // if the key is wrong at first run.
      }

      // S-TC2 (council 2026-05-05 P2 — analytics milestone for paid users).
      //
      // The "10-min first value" S3 demo metrics ("32% of signups from
      // LinkedIn") require Stripe + PostHog + LinkedIn. Pre-fix, the
      // `integrations` field defaulted to `{}` and onboarding completed
      // without any analytics intent — leaving GrowthConsole to fall back
      // to MOCK data on a paid surface. The fix: for active subscriptions,
      // require the founder to commit to wiring at least ONE analytics
      // connector before bootstrap completes.
      //
      // Trial / free users skip this gate — onboarding must NOT dead-end
      // a brand-new founder on day 1. The matching UI side of the gate is
      // in `ui/src/pages/departments/GrowthConsole.tsx`: paid + no
      // integrations yet = explicit AnalyticsConnectPrompt, never mocks.
      const isPaid = await subscriptionService(db)
        .isSubscriptionActive()
        .catch((err) => {
          // Failure to read billing status is NON-fatal here. We log and
          // proceed as "free" — the conservative direction for an
          // onboarding gate is to let the founder through, not to block
          // them on a billing-API outage. The trust-gate's downstream
          // counterpart (GrowthConsole) reads billing status on its own
          // and will refuse to render mocks if `isPaid` is true at the
          // time of dashboard render.
          logger.warn(
            { err },
            "onboarding: billing-status check failed — treating as free for milestone gate",
          );
          return false;
        });

      if (isPaid) {
        const integrationsFlags = input.integrations ?? {};
        const hasAnalytics = ANALYTICS_INTEGRATION_KEYS.some(
          (key) => integrationsFlags[key] === true,
        );
        if (!hasAnalytics) {
          throw unprocessable(
            "An analytics integration is required before completing onboarding on a paid plan",
            {
              code: "ANALYTICS_INTEGRATION_REQUIRED",
              acceptedKinds: [...ANALYTICS_INTEGRATION_KEYS],
              hint:
                "Pick at least one of Stripe, PostHog, or LinkedIn during onboarding " +
                "so we can populate the GrowthConsole with real numbers instead of " +
                "showing sample data on a paid surface.",
            },
          );
        }
      }

      const actorUserId = req.actor.userId ?? "local-board";
      const companyName =
        input.companyName?.trim() || deriveCompanyNameFromVision(input.vision);

      const bootstrapInput: BootstrapInput = {
        vision: input.vision,
        bottlenecks: input.bottlenecks,
        team: input.team,
        cofounder: input.cofounder ?? null,
        adapterChoice: input.adapterChoice,
        anthropicKey: input.anthropicKey,
        integrations: input.integrations ?? {},
        nonCoreDepartments: input.nonCoreDepartments ?? [],
        autonomyLevel: input.autonomyLevel ?? 2,
        charters: input.charters,
        companyName,
      };

      const result = await bootstrapCompanyOnboarding(db, bootstrapInput, {
        actorUserId,
      });

      // S-TC1 (council 2026-05-05 P1) — persist the founder's telemetry
      // consent decision. We do this OUTSIDE the bootstrap transaction:
      // a failure here MUST NOT bring down onboarding, but it also MUST
      // NOT silently flip default behavior. The default in
      // `loadConfig()` is OFF, so on failure the system stays OFF — the
      // safe direction for a privacy gate.
      try {
        const decidedAt = new Date().toISOString();
        await settings.updateGeneral({
          telemetryConsent: {
            enabled: input.telemetryEnabled,
            decided: true,
            decidedAt,
          },
        });

        // Council 2026-05-05 P2 (C1) — hot-reload the runtime telemetry
        // client so the founder's consent decision takes effect immediately,
        // not on next boot. Non-fatal: persisted state is the source of
        // truth; a hydration failure leaves the client in its current state
        // (file-config-driven) until the next reinit trigger.
        try {
          const { reinitTelemetryFromInstanceSettings } = await import("../telemetry.js");
          await reinitTelemetryFromInstanceSettings(db);
        } catch (reinitErr) {
          logger.warn({ err: reinitErr }, "onboarding: telemetry reinit after consent failed");
        }
      } catch (err) {
        logger.warn(
          { err, telemetryEnabled: input.telemetryEnabled },
          "onboarding: failed to persist telemetry consent — defaulting to OFF",
        );
      }

      // S3.10 — strip the firstRunPromise from the wire response. It exists
      // on the result object so tests + workers can await the magic-moment
      // orchestrator; the founder's wizard polls
      // GET /api/companies/:companyId/first-run-progress for status.
      const {
        firstRunPromise: _firstRunPromise,
        ...wireResult
      } = result;
      void _firstRunPromise;
      res.status(201).json(wireResult);
    },
  );

  /**
   * GET /api/companies/:companyId/first-run-progress
   *
   * S3.10 — surfaces in-memory first-run progress for the dashboard's
   * "Generating your first executive brief…" UI. Returns null when the
   * gate did not fire (< 2 integrations) or the progress map evicted the
   * row after a long idle period (server restart).
   */
  router.get(
    "/companies/:companyId/first-run-progress",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      requireCompanyAccess(req, companyId);
      const { getFirstRunProgress } = await import(
        "../services/onboarding/first-run.js"
      );
      const progress = getFirstRunProgress(companyId);
      res.json({ progress });
    },
  );

  /**
   * POST /api/onboarding/first-decisions
   * Server-authoritative first-decision cards for a bottleneck set.
   */
  router.post(
    "/onboarding/first-decisions",
    validate(firstDecisionsSchema),
    async (req, res) => {
      assertBoard(req);
      const input = req.body as z.infer<typeof firstDecisionsSchema>;
      const { decisions, source } = await generateFirstDecisions(db, {
        vision: input.vision,
        bottlenecks: input.bottlenecks,
        team: input.team,
        companyName: input.companyName,
      });
      res.json({ decisions, source });
    },
  );

  /**
   * POST /api/onboarding/accept-decision
   * Turns the founder's chosen first decision into an issue assigned to
   * the owning agent. Non-fatal — the UI can recover by landing on the
   * dashboard and letting the founder pick again.
   */
  router.post(
    "/onboarding/accept-decision",
    validate(acceptDecisionSchema),
    async (req, res) => {
      assertBoard(req);
      const input = req.body as z.infer<typeof acceptDecisionSchema>;
      requireCompanyAccess(req, input.companyId);

      const ownerAgentId = input.agentIdsBySlot[input.decision.slot];
      if (!ownerAgentId) {
        throw unprocessable(
          `No agent provisioned for slot: ${input.decision.slot}`,
        );
      }

      if (!input.projectId) {
        throw unprocessable(
          "projectId required to stage first decision as an issue",
        );
      }

      const description = [
        input.decision.rationale,
        "",
        "Staged from FounderOS onboarding (first decision, pre-approved).",
      ].join("\n");

      const issue = await issues.create(input.companyId, {
        title: input.decision.title,
        description,
        assigneeAgentId: ownerAgentId,
        projectId: input.projectId,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        status: "todo",
      });

      await logActivity(db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          source: "founder_onboarding_first_decision",
          decisionId: input.decision.id,
        },
      });

      res.status(201).json({
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        assignedAgentId: ownerAgentId,
      });
    },
  );

  return router;
}
