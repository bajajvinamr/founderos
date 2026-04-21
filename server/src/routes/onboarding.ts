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
import type { Db } from "@founderos/db";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import {
  accessService,
  agentService,
  companyMemoryService,
  companyService,
  goalService,
  issueService,
  logActivity,
  projectService,
  secretService,
  validateAnthropicKey,
} from "../services/index.js";
import type { AgentRole } from "@founderos/shared";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const AGENT_SLOTS = ["cos", "growth", "content", "finance"] as const;
type AgentSlot = (typeof AGENT_SLOTS)[number];

const SLOT_TO_ROLE: Record<AgentSlot, AgentRole> = {
  cos: "ceo",
  growth: "cmo",
  content: "general",
  finance: "cfo",
};

const DEFAULT_COMPANY_NAME = "My Company";
const ANTHROPIC_SECRET_NAME = "ANTHROPIC_API_KEY";

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
  anthropicKey: z.string().min(10),
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
  bottlenecks: z.array(z.string().min(1)).min(1).max(2),
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

function buildAgentAdapterConfig(anthropicSecretId: string) {
  return {
    env: {
      ANTHROPIC_API_KEY: {
        type: "secret_ref" as const,
        secretId: anthropicSecretId,
        version: "latest" as const,
      },
    },
  };
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
  const companies = companyService(db);
  const access = accessService(db);
  const secrets = secretService(db);
  const agents = agentService(db);
  const goals = goalService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const memory = companyMemoryService(db);

  /**
   * POST /api/onboarding/bootstrap
   *
   * Creates the full starter company in one call. Returns enough state
   * for the UI to immediately navigate to the new company's dashboard.
   */
  router.post(
    "/onboarding/bootstrap",
    validate(bootstrapSchema),
    async (req, res) => {
      assertBoard(req);
      const instanceAdmin =
        req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
      if (!instanceAdmin) {
        throw forbidden("Instance admin required for onboarding bootstrap");
      }

      const input = req.body as z.infer<typeof bootstrapSchema>;

      // 1. Validate the Anthropic key against the live API before we
      //    start mutating state. Fail fast if the key is wrong — nothing
      //    worse than finishing onboarding and discovering no agent can
      //    actually run.
      const keyCheck = await validateAnthropicKey(input.anthropicKey);
      if (!keyCheck.valid) {
        throw unprocessable(
          `Anthropic API key rejected: ${keyCheck.reason ?? "unknown"}`,
        );
      }

      const actorUserId = req.actor.userId ?? "local-board";
      const companyName =
        input.companyName?.trim() || deriveCompanyNameFromVision(input.vision);

      // 2. Company row + membership.
      const company = await companies.create({ name: companyName });
      await access.ensureMembership(
        company.id,
        "user",
        actorUserId,
        "owner",
        "active",
      );

      // 3. Anthropic key as a company secret.
      const secret = await secrets.create(
        company.id,
        {
          name: ANTHROPIC_SECRET_NAME,
          provider: "local_encrypted",
          value: input.anthropicKey,
          description: "Auto-saved during FounderOS onboarding",
        },
        { userId: actorUserId },
      );

      // 4. Company goal + onboarding project.
      const goal = await goals.create(company.id, {
        title: `Ship ${companyName}`,
        description: input.vision,
        level: "company",
        status: "active",
      });

      const project = await projects.create(company.id, {
        name: "Onboarding",
        status: "in_progress",
        goalIds: goal ? [goal.id] : [],
      });

      // 5. Founder vision → company memory.
      await memory
        .create(company.id, {
          kind: "founder_note",
          title: "Founder vision (onboarding)",
          body: input.vision,
          topic: "vision",
          pinned: true,
          source: "manual",
        })
        .catch(() => null);
      await memory
        .create(company.id, {
          kind: "founder_note",
          title: "Current bottlenecks (onboarding)",
          body: `Bottlenecks: ${input.bottlenecks.join(", ")}\nTeam shape: ${input.team}`,
          topic: "focus",
          pinned: false,
          source: "manual",
        })
        .catch(() => null);

      // 6. Provision four agents with charters.
      const adapterConfig = buildAgentAdapterConfig(secret.id);
      const agentIdsBySlot: Record<AgentSlot, string> = {
        cos: "",
        growth: "",
        content: "",
        finance: "",
      };

      for (const slot of AGENT_SLOTS) {
        const charter = input.charters[slot];
        const role = SLOT_TO_ROLE[slot];
        const agent = await agents.create(company.id, {
          name: charter.name,
          role,
          title: charter.title,
          capabilities: charter.charter,
          adapterType: "claude_local",
          adapterConfig,
          status: "idle",
          spentMonthlyCents: 0,
          budgetMonthlyCents: 0,
        });
        agentIdsBySlot[slot] = agent.id;
      }

      await logActivity(db, {
        companyId: company.id,
        actorType: "user",
        actorId: actorUserId,
        action: "company.created",
        entityType: "company",
        entityId: company.id,
        details: {
          source: "founder_onboarding_v2",
          bottlenecks: input.bottlenecks,
          team: input.team,
        },
      });

      res.status(201).json({
        companyId: company.id,
        companyPrefix: company.issuePrefix,
        agentIdsBySlot,
        goalId: goal?.id ?? null,
        projectId: project.id,
      });
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
      res.json({ decisions: buildServerFirstDecisions(input.bottlenecks) });
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
