import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { requireCompanyAccess } from "../middleware/require-company-access.js";
import { assertBoard } from "./authz.js";
import { agentHandoffService } from "../services/agent-handoff.js";
import { notFound, unprocessable } from "../errors.js";

const createSchema = z.object({
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  fromIssueId: z.string().uuid().nullable().optional(),
  request: z.string().min(4).max(4000),
  context: z.record(z.unknown()).optional(),
});

const completeSchema = z.object({
  result: z.string().min(1).max(4000),
  resultRef: z.string().max(500).nullable().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export function agentHandoffRoutes(db: Db) {
  const router = Router();
  const svc = agentHandoffService(db);

  router.get("/companies/:companyId/handoffs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    requireCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = await svc.listForCompany(companyId, {
      status: status as Parameters<typeof svc.listForCompany>[1] extends infer T
        ? T extends { status?: infer S } ? S : never
        : never,
      limit,
    });
    res.json({ handoffs: rows });
  });

  router.get("/companies/:companyId/handoffs/:id", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertBoard(req);
    requireCompanyAccess(req, companyId);
    const row = await svc.getById(id);
    if (!row || row.companyId !== companyId) throw notFound("Handoff not found");
    res.json(row);
  });

  router.post(
    "/companies/:companyId/handoffs",
    validate(createSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      requireCompanyAccess(req, companyId);
      const input = req.body as z.infer<typeof createSchema>;
      try {
        const row = await svc.create({
          companyId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          fromIssueId: input.fromIssueId ?? null,
          request: input.request,
          context: input.context,
        });
        res.status(201).json(row);
      } catch (err) {
        throw unprocessable(
          err instanceof Error ? err.message : "Failed to create handoff",
        );
      }
    },
  );

  router.post("/companies/:companyId/handoffs/:id/accept", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertBoard(req);
    requireCompanyAccess(req, companyId);
    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId) throw notFound("Handoff not found");
    const row = await svc.accept(id);
    res.json(row);
  });

  router.post(
    "/companies/:companyId/handoffs/:id/complete",
    validate(completeSchema),
    async (req, res) => {
      const { companyId, id } = req.params as { companyId: string; id: string };
      assertBoard(req);
      requireCompanyAccess(req, companyId);
      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) throw notFound("Handoff not found");
      const input = req.body as z.infer<typeof completeSchema>;
      const row = await svc.complete(id, {
        result: input.result,
        resultRef: input.resultRef ?? null,
      });
      res.json(row);
    },
  );

  router.post(
    "/companies/:companyId/handoffs/:id/reject",
    validate(rejectSchema),
    async (req, res) => {
      const { companyId, id } = req.params as { companyId: string; id: string };
      assertBoard(req);
      requireCompanyAccess(req, companyId);
      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) throw notFound("Handoff not found");
      const input = req.body as z.infer<typeof rejectSchema>;
      const row = await svc.reject(id, input.reason);
      res.json(row);
    },
  );

  return router;
}
