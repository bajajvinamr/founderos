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
import { authUsers, instanceUserRoles, type Db } from "@founderos/db";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { requireCompanyAccess } from "../middleware/require-company-access.js";
import { assertBoard } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { runPostSignupBootstrap } from "../auth/post-signup-hook.js";
import {
  issueService,
  logActivity,
  validateAnthropicKey,
} from "../services/index.js";
import {
  AGENT_SLOTS,
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
  adapterChoice: z.enum(["claude_local", "anthropic_api", "skip"]).optional().default("anthropic_api"),
  anthropicKey: z.string().default(""),
  integrations: z.record(z.boolean()).optional().default({}),
  charters: z.object({
    cos: charterSchema,
    growth: charterSchema,
    content: charterSchema,
    finance: charterSchema,
  }),
  companyName: z.string().min(1).max(120).optional(),
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
    validate(bootstrapSchema),
    async (req, res) => {
      assertBoard(req);
      let instanceAdmin =
        req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
      if (!instanceAdmin) {
        // Self-heal: the auth-middleware inline bootstrap may have skipped
        // (missing email on session, race against signup, transient DB
        // failure). If the caller has a valid board session AND no human
        // admin exists yet, run the same first-user-wins promotion now and
        // re-check. This keeps the onboarding wizard from dead-ending the
        // first user when Path A (Supabase webhook) and Path B (middleware)
        // both miss.
        const userId = req.actor.userId;
        if (userId) {
          let email = "";
          try {
            const userRow = await db
              .select({ email: authUsers.email })
              .from(authUsers)
              .where(eq(authUsers.id, userId))
              .then((rows) => rows[0] ?? null);
            email = userRow?.email ?? "";
          } catch (err) {
            logger.warn({ err, userId }, "onboarding self-heal: email lookup failed");
          }

          try {
            await runPostSignupBootstrap(db, { userId, email });
          } catch (err) {
            logger.warn({ err, userId }, "onboarding self-heal: runPostSignupBootstrap threw");
          }

          const refreshed = await db
            .select({ id: instanceUserRoles.id })
            .from(instanceUserRoles)
            .where(
              and(
                eq(instanceUserRoles.userId, userId),
                eq(instanceUserRoles.role, "instance_admin"),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (refreshed) {
            req.actor = { ...req.actor, isInstanceAdmin: true };
            instanceAdmin = true;
            logger.info({ userId }, "onboarding self-heal: promoted caller to instance_admin");
          }
        }

        if (!instanceAdmin) {
          throw forbidden("Instance admin required for onboarding bootstrap", {
            code: "INSTANCE_ADMIN_REQUIRED",
            hint:
              "No instance admin exists yet and auto-promotion did not run. " +
              "Operator: confirm SUPABASE_WEBHOOK_SECRET is set on the server, " +
              "or seed the first admin via `pnpm founderos auth bootstrap-ceo`.",
          });
        }
      }

      const input = req.body as z.infer<typeof bootstrapSchema>;

      if (input.adapterChoice === "anthropic_api") {
        if (!input.anthropicKey || input.anthropicKey.length < 10) {
          throw unprocessable(
            "Anthropic API key is required when adapterChoice is 'anthropic_api'",
          );
        }
        const keyCheck = await validateAnthropicKey(input.anthropicKey);
        if (!keyCheck.valid) {
          throw unprocessable(
            `Anthropic API key rejected: ${keyCheck.reason ?? "unknown"}`,
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
        charters: input.charters,
        companyName,
      };

      const result = await bootstrapCompanyOnboarding(db, bootstrapInput, {
        actorUserId,
      });
      res.status(201).json(result);
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
