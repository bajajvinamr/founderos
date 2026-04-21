import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";
import { draftHireProposal, hireProposalSchema } from "../services/hire-proposal.js";

const hireProposalRequestSchema = z.object({
  intent: z.string().min(1).max(2000),
  previousDraft: hireProposalSchema.optional(),
});

export function hireProposalRoutes(db: Db) {
  const router = Router();

  router.post(
    "/:companyId/hire-proposal",
    validate(hireProposalRequestSchema),
    async (req, res) => {
      const companyId = req.params["companyId"] as string;
      assertCompanyAccess(req, companyId);

      const { intent, previousDraft } = req.body as z.infer<typeof hireProposalRequestSchema>;

      const proposal = await draftHireProposal({
        db,
        companyId,
        intent,
        previousDraft,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.proposal_drafted",
        entityType: "hire_proposal",
        entityId: companyId,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          intent: intent.slice(0, 200),
          proposedName: proposal.name,
          proposedRole: proposal.role,
          isRedraft: Boolean(previousDraft),
        },
      });

      res.json(proposal);
    },
  );

  return router;
}
