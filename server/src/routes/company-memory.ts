import { Router } from "express";
import type { Db } from "@founderos/db";
import {
  createCompanyMemorySchema,
  updateCompanyMemorySchema,
  generateWeeklySummarySchema,
} from "@founderos/shared";
import { validate } from "../middleware/validate.js";
import { companyMemoryService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { MemoryKind } from "@founderos/shared";

export function companyMemoryRoutes(db: Db) {
  const router = Router();
  const memory = companyMemoryService(db);

  /**
   * GET /api/companies/:companyId/memory
   * List entries. Optional ?kind, ?limit, ?pinned query params.
   */
  router.get("/companies/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const kind = req.query.kind as MemoryKind | undefined;
    const pinned =
      req.query.pinned === "true" ? true : req.query.pinned === "false" ? false : undefined;

    const entries = await memory.list(companyId, { limit, kind, pinned });
    res.json(entries);
  });

  /**
   * POST /api/companies/:companyId/memory
   * Create a manual memory entry (source forced to 'manual').
   */
  router.post(
    "/companies/:companyId/memory",
    validate(createCompanyMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const entry = await memory.create(companyId, {
        kind: req.body.kind ?? "founder_note",
        title: req.body.title,
        body: req.body.body,
        topic: req.body.topic ?? null,
        occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : undefined,
        pinned: req.body.pinned ?? false,
        source: "manual",
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.entry_created",
        entityType: "company_memory",
        entityId: entry.id,
        details: { kind: entry.kind, title: entry.title },
      });

      res.status(201).json(entry);
    },
  );

  /**
   * PATCH /api/companies/:companyId/memory/:entryId
   * Update title, body, topic, or pinned.
   */
  router.patch(
    "/companies/:companyId/memory/:entryId",
    validate(updateCompanyMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const entryId = req.params.entryId as string;
      assertCompanyAccess(req, companyId);

      const updated = await memory.update(entryId, {
        title: req.body.title,
        body: req.body.body,
        topic: req.body.topic,
        pinned: req.body.pinned,
      });

      if (!updated) {
        res.status(404).json({ error: "Memory entry not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: req.body.pinned !== undefined ? "memory.entry_pinned" : "memory.entry_updated",
        entityType: "company_memory",
        entityId: entryId,
        details: { pinned: updated.pinned },
      });

      res.json(updated);
    },
  );

  /**
   * DELETE /api/companies/:companyId/memory/:entryId
   * Remove an entry.
   */
  router.delete("/companies/:companyId/memory/:entryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    assertCompanyAccess(req, companyId);

    const removed = await memory.remove(entryId);
    if (!removed) {
      res.status(404).json({ error: "Memory entry not found" });
      return;
    }

    res.status(204).end();
  });

  /**
   * POST /api/companies/:companyId/memory/generate-weekly
   * Trigger auto-generation of a weekly summary.
   * Body: { weekOf: 'YYYY-MM-DD' }
   */
  router.post(
    "/companies/:companyId/memory/generate-weekly",
    validate(generateWeeklySummarySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const entry = await memory.generateWeeklySummary(companyId, req.body.weekOf);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "memory.entry_created",
        entityType: "company_memory",
        entityId: entry.id,
        details: { kind: "weekly_summary", weekOf: req.body.weekOf },
      });

      res.json(entry);
    },
  );

  return router;
}
