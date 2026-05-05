/**
 * workflows.ts — Lifecycle CRM workflow registry routes (S4.5)
 *
 * ## RBAC Matrix
 *
 *   Endpoint                                      | board (member) | board (instance-admin) | agent (own company)
 *   ----------------------------------------------|---------------|----------------------|-------------------
 *   GET  /companies/:id/workflows                 | ✓ (own co)    | ✓                    | ✓ (own co)
 *   GET  /companies/:id/workflows/:wid            | ✓ (own co)    | ✓                    | ✓ (own co)
 *   POST /companies/:id/workflows                 | ✓ (own co)    | ✓                    | ✓ (own co)
 *   PATCH /companies/:id/workflows/:wid           | ✓ (own co)    | ✓                    | ✓ (own co)
 *   POST /companies/:id/workflows/:wid/activate   | ✓ (own co)    | ✓                    | ✗ (blocked)
 *   POST /companies/:id/workflows/:wid/pause      | ✓ (own co)    | ✓                    | ✗ (blocked)
 *   GET  /companies/:id/workflows/:wid/runs       | ✓ (own co)    | ✓                    | ✓ (own co)
 *   POST /companies/:id/workflows/:wid/runs       | ✓ (own co)    | ✓                    | ✓ (own co)
 *
 * "own co" = assertCompanyAccess enforces the actor can only access the
 * companyId in the path. Cross-company access (reading company A's workflows
 * via company B's path) is blocked by assertCompanyAccess for both board and
 * agent actor types. There is no admin-bypass for cross-tenant reads.
 *
 * Activate/pause are board-only because lifecycle state transitions have
 * billing and customer-impact implications — agents should not be able to
 * self-activate an autonomous workflow.
 *
 * ## Autonomy-level write rules
 *   - autonomyLevel defaults to 2 (draft) on create if not provided.
 *   - autonomyLevel=4 (autonomous) is accepted on the wire but gated:
 *     the route calls canRunAutonomously() to verify the instance-level flag
 *     is set. If not, 409 is returned and the write is rejected.
 *   - autonomyLevel is not constrained to only increase — a founder can
 *     downgrade from 4→3 to add an approval step back. Downgrade is always
 *     permitted; upgrade to 4 requires the instance flag.
 *
 * ## Drizzle invariant
 *   All DB queries go through the service layer. Service uses and(...) for
 *   all multi-predicate queries. No raw .where().where() chaining.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import {
  WORKFLOW_TEMPLATES,
  WORKFLOW_TRIGGER_KINDS,
  WORKFLOW_STATUSES,
  WORKFLOW_RUN_STATUSES,
  AUTONOMY_LEVELS,
} from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertStrictCompanyMembership, getActorInfo } from "./authz.js";
import { notFound, conflict, badRequest } from "../errors.js";
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  activateWorkflow,
  pauseWorkflow,
  listWorkflowRuns,
  createWorkflowRun,
  executeWorkflowTemplate,
  setRunStatus,
} from "../services/workflows.js";
import { canRunAutonomously } from "../services/workflow-autonomy.js";
import { logger } from "../middleware/logger.js";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const createWorkflowSchema = z.object({
  name: z.string().min(1).max(500),
  template: z.enum(WORKFLOW_TEMPLATES),
  triggerKind: z.enum(WORKFLOW_TRIGGER_KINDS),
  triggerSpec: z.record(z.unknown()),
  /**
   * autonomyLevel: 1–4. Defaults to 2 (draft) if omitted.
   * autonomyLevel=4 additionally requires the instance flag — see route handler.
   */
  autonomyLevel: z.number().int().min(1).max(4).optional().default(AUTONOMY_LEVELS.DRAFT),
  status: z.enum(WORKFLOW_STATUSES).optional().default("draft"),
  config: z.record(z.unknown()).optional().default({}),
});

const patchWorkflowSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  status: z.enum(WORKFLOW_STATUSES).optional(),
  autonomyLevel: z.number().int().min(1).max(4).optional(),
  triggerKind: z.enum(WORKFLOW_TRIGGER_KINDS).optional(),
  triggerSpec: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "Patch body must include at least one field" },
);

const listWorkflowQuerySchema = z.object({
  status: z.enum(WORKFLOW_STATUSES).optional(),
  template: z.enum(WORKFLOW_TEMPLATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createRunSchema = z.object({
  triggeredBy: z.object({
    kind: z.enum(["event", "schedule", "manual"]),
  }).passthrough(),
  metricSnapshot: z.record(z.unknown()).optional(),
});

const listRunQuerySchema = z.object({
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ── Helper: gate autonomy=4 upgrade ──────────────────────────────────────────

/**
 * Throws 409 if the caller is trying to set autonomyLevel=4 but the
 * instance-level opt-in flag is not enabled.
 *
 * This is called on both POST (create) and PATCH (update with autonomyLevel=4).
 * The check is intentionally placed at the route layer — before the DB write —
 * so the rejection is cheap and the audit trail only contains legitimate rows.
 */
async function guardAutonomousUpgrade(db: Db, autonomyLevel: number): Promise<void> {
  if (autonomyLevel !== AUTONOMY_LEVELS.AUTONOMOUS) return;

  // We pass a minimal workflow shape; canRunAutonomously only reads autonomyLevel
  // from the workflow argument and checks the instance flag from the DB.
  const permitted = await canRunAutonomously(db, { autonomyLevel });
  if (!permitted) {
    throw conflict(
      "autonomyLevel=4 (autonomous) requires the instance admin to enable " +
      "'lifecycle_crm.allow_autonomous_email' in instance settings. " +
      "Set autonomyLevel=3 (approval-required) or enable the instance flag first.",
    );
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export function workflowRoutes(db: Db) {
  const router = Router();

  // ── GET /api/companies/:companyId/workflows ─────────────────────────────

  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    // RBAC: board + agent — assertCompanyAccess gates cross-tenant reads.
    assertCompanyAccess(req, companyId);

    const query = listWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query parameters", details: query.error.flatten() });
      return;
    }
    const { status, template, limit, offset } = query.data;

    const result = await listWorkflows(db, companyId, { status, template, limit, offset });
    res.json({ workflows: result.workflows, meta: { total: result.total, limit, offset } });
  });

  // ── GET /api/companies/:companyId/workflows/:workflowId ─────────────────

  router.get("/companies/:companyId/workflows/:workflowId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workflowId = req.params.workflowId as string;
    assertCompanyAccess(req, companyId);

    const workflow = await getWorkflow(db, companyId, workflowId);
    if (!workflow) throw notFound("Workflow not found");

    res.json(workflow);
  });

  // ── POST /api/companies/:companyId/workflows ────────────────────────────

  router.post(
    "/companies/:companyId/workflows",
    validate(createWorkflowSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      // RBAC: board members and agents of the same company may create workflows.
      // Council 2026-05-06 P1 BLOCK fix — strict membership for write paths,
      // no instance-admin cross-tenant bypass on autonomy-creating endpoints.
      // Activate/pause/runs are also gated by assertStrictCompanyMembership below.
      assertStrictCompanyMembership(req, companyId);

      const body = req.body as z.infer<typeof createWorkflowSchema>;

      // Gate: autonomyLevel=4 requires the instance opt-in flag.
      await guardAutonomousUpgrade(db, body.autonomyLevel);

      const { actorType, actorId, agentId, runId } = getActorInfo(req);

      const workflow = await createWorkflow(db, {
        companyId,
        actorType,
        actorId,
        agentId,
        runId,
        data: {
          name: body.name,
          template: body.template,
          triggerKind: body.triggerKind,
          triggerSpec: body.triggerSpec,
          autonomyLevel: body.autonomyLevel,
          status: body.status,
          config: body.config,
        },
      });

      res.status(201).json(workflow);
    },
  );

  // ── PATCH /api/companies/:companyId/workflows/:workflowId ───────────────

  router.patch(
    "/companies/:companyId/workflows/:workflowId",
    validate(patchWorkflowSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const workflowId = req.params.workflowId as string;
      // Council 2026-05-06 P1 BLOCK fix — PATCH can flip autonomyLevel to 4,
      // which is autonomy-relevant. Strict membership only.
      assertStrictCompanyMembership(req, companyId);

      const body = req.body as z.infer<typeof patchWorkflowSchema>;

      // Gate: upgrading autonomyLevel to 4 requires the instance flag.
      if (body.autonomyLevel !== undefined) {
        await guardAutonomousUpgrade(db, body.autonomyLevel);
      }

      const { actorType, actorId, agentId, runId } = getActorInfo(req);

      const updated = await updateWorkflow(db, {
        companyId,
        workflowId,
        actorType,
        actorId,
        agentId,
        runId,
        patch: body,
      });

      if (!updated) throw notFound("Workflow not found");

      res.json(updated);
    },
  );

  // ── POST /api/companies/:companyId/workflows/:workflowId/activate ────────
  //
  // Board-only — agents cannot self-activate workflows.
  // Rationale: activating a workflow can trigger customer-facing sends.
  // Requires a human decision.

  router.post("/companies/:companyId/workflows/:workflowId/activate", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workflowId = req.params.workflowId as string;

    // Stricter than assertCompanyAccess: board only (no agent tokens) AND
    // strict membership (no instance-admin cross-tenant bypass).
    // Council 2026-05-06 P1 BLOCK fix.
    assertBoard(req);
    assertStrictCompanyMembership(req, companyId);

    const { actorType, actorId } = getActorInfo(req);

    const updated = await activateWorkflow(db, companyId, workflowId, actorType, actorId);
    if (!updated) throw notFound("Workflow not found");

    res.json(updated);
  });

  // ── POST /api/companies/:companyId/workflows/:workflowId/pause ───────────
  //
  // Board-only — same rationale as activate.

  router.post("/companies/:companyId/workflows/:workflowId/pause", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workflowId = req.params.workflowId as string;

    // Council 2026-05-06 P1 BLOCK fix — strict membership.
    assertBoard(req);
    assertStrictCompanyMembership(req, companyId);

    const { actorType, actorId } = getActorInfo(req);

    const updated = await pauseWorkflow(db, companyId, workflowId, actorType, actorId);
    if (!updated) throw notFound("Workflow not found");

    res.json(updated);
  });

  // ── GET /api/companies/:companyId/workflows/:workflowId/runs ─────────────

  router.get("/companies/:companyId/workflows/:workflowId/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workflowId = req.params.workflowId as string;
    assertCompanyAccess(req, companyId);

    // Verify the workflow belongs to this company before listing its runs.
    // Prevents an attacker from enumerating runs of an unknown workflowId by
    // pairing it with their own companyId.
    const workflow = await getWorkflow(db, companyId, workflowId);
    if (!workflow) throw notFound("Workflow not found");

    const query = listRunQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query parameters", details: query.error.flatten() });
      return;
    }
    const { status, limit, offset } = query.data;

    const result = await listWorkflowRuns(db, companyId, workflowId, { status, limit, offset });
    res.json({ runs: result.runs, meta: { total: result.total, limit, offset } });
  });

  // ── POST /api/companies/:companyId/workflows/:workflowId/runs ────────────
  //
  // Creates a new workflow run (manual trigger). The autonomy gate is NOT
  // checked here — run creation is distinct from run execution. The run's
  // initial status reflects the workflow's autonomyLevel:
  //   autonomy=3 → status="pending_approval"
  //   otherwise  → status="running" (template code drives execution)
  //
  // The execution engine (S4.6–S4.9 templates) checks canRunAutonomously
  // before any customer-facing side effects.

  router.post(
    "/companies/:companyId/workflows/:workflowId/runs",
    validate(createRunSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const workflowId = req.params.workflowId as string;
      // Council 2026-05-06 P1 BLOCK fix — runs trigger autonomous side
      // effects when the workflow is level 4 + flag enabled. Strict
      // membership keeps cross-tenant instance-admins out of customer
      // sends.
      assertStrictCompanyMembership(req, companyId);

      const workflow = await getWorkflow(db, companyId, workflowId);
      if (!workflow) throw notFound("Workflow not found");

      if (workflow.status !== "active") {
        throw badRequest(
          `Workflow is ${workflow.status} — only active workflows can be triggered`,
        );
      }

      const body = req.body as z.infer<typeof createRunSchema>;
      const { actorType, actorId, agentId, runId } = getActorInfo(req);

      // Council 2026-05-06 P1 BLOCK fix — re-check the autonomy flag at run
      // creation time, NOT just at workflow creation. Without this, a workflow
      // created at level=4 when the flag was true continues to autonomously
      // execute even after the admin disables the kill switch — flag flip
      // becomes a future-only signal, useless for incident response.
      //
      // Decision matrix:
      //   level 1 (draft):     status="running" (manual; template gates sends)
      //   level 2 (manual):    status="running"
      //   level 3 (approval):  status="pending_approval" (always — humans gate)
      //   level 4 (autonomous):
      //     flag enabled:  status="running"
      //     flag disabled: status="pending_approval" (downgrade — kill switch)
      let initialStatus: "running" | "pending_approval";
      if (workflow.autonomyLevel === AUTONOMY_LEVELS.APPROVAL_REQUIRED) {
        initialStatus = "pending_approval";
      } else if (workflow.autonomyLevel === AUTONOMY_LEVELS.AUTONOMOUS) {
        const stillPermitted = await canRunAutonomously(db, workflow);
        initialStatus = stillPermitted ? "running" : "pending_approval";
      } else {
        // Levels 1 + 2 — draft / manual; the template code itself gates
        // any customer-facing side effect.
        initialStatus = "running";
      }

      const run = await createWorkflowRun(db, {
        companyId,
        workflowId,
        actorType,
        actorId,
        agentId,
        runId,
        data: {
          status: initialStatus,
          triggeredBy: body.triggeredBy,
          metricSnapshot: body.metricSnapshot ?? null,
          actions: [],
        },
      });

      // Council 2026-05-05 W0.1 BLOCK fix — wire route → executor.
      // Before this commit, the route created the workflow_run row and returned
      // 201 immediately; executeWorkflowTemplate was only invoked from tests.
      // Result: founder UI showed "succeeded" but no template ever executed.
      //
      // Dispatch model — synchronous fire-and-forget via setImmediate. The
      // request returns immediately so the founder UI is responsive. The
      // executor runs on the next event-loop tick, on the same node.
      //
      // Trade-offs (logged in MORNING-REPORT-2026-05-06.md as HIGH severity):
      //   - Crash-safety gap: if the server crashes BETWEEN createWorkflowRun
      //     and the setImmediate tick, the run is stuck at "running" forever.
      //   - Deviates from LRP cross-cutting default "BullMQ + plain async".
      //   - Acceptable for the staging-only client demo (deploys are infrequent
      //     and re-runs are explicit). Replace with BullMQ in S6 polish.
      //
      // Only dispatch when initialStatus === "running" — pending_approval runs
      // are dispatched separately by the approval workflow when the human acts.
      if (initialStatus === "running") {
        setImmediate(() => {
          executeWorkflowTemplate(db, workflow, run).catch(async (err) => {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(
              { runId: run.id, workflowId: workflow.id, err },
              "executeWorkflowTemplate threw — marking run failed",
            );
            try {
              await setRunStatus(db, run.id, "failed", { error: reason });
            } catch (statusErr) {
              logger.error(
                { runId: run.id, err: statusErr },
                "setRunStatus failed; run may be stuck at 'running'",
              );
            }
          });
        });
      }

      res.status(201).json(run);
    },
  );

  return router;
}
