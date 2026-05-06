import { Router } from "express";
import type { Db } from "@founderos/db";
import { saveOnboardingDraftSchema } from "@founderos/shared";
import { onboardingDraftService } from "../services/onboarding-drafts.js";
import { assertBoard } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";

/**
 * Onboarding draft persistence (S6.8).
 *
 * RBAC:
 *   - All routes require board (logged-in user).
 *   - The draft is bound to actor.userId — there's no path to read or
 *     write another user's draft. No tenant scoping needed (drafts are
 *     pre-company; userId IS the scope).
 *
 * Routes:
 *   GET    /api/onboarding/draft           — get or create
 *   PUT    /api/onboarding/draft           — save progress
 *   POST   /api/onboarding/draft/complete  — mark done
 */
export function onboardingDraftRoutes(db: Db) {
  const router = Router();
  const service = onboardingDraftService(db);

  function requireUserId(
    req: Parameters<Parameters<typeof router.get>[1]>[0],
  ): string {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("User identity required for onboarding draft");
    }
    return req.actor.userId;
  }

  router.get("/onboarding/draft", async (req, res) => {
    assertBoard(req);
    const userId = requireUserId(req);
    const draft = await service.getOrCreate(userId);
    res.json(draft);
  });

  router.put("/onboarding/draft", async (req, res) => {
    assertBoard(req);
    const userId = requireUserId(req);

    const parsed = saveOnboardingDraftSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("invalid draft payload");

    const updated = await service.save(userId, {
      currentStep: parsed.data.currentStep,
      draft: parsed.data.draft,
    });

    if (!updated) {
      // No in-progress draft — UI should call GET first to materialize one,
      // then PUT. We could auto-create-on-PUT but that masks a UX bug
      // (something weird happened — UI hadn't loaded the draft state).
      res.status(409).json({ error: "no_active_draft" });
      return;
    }
    res.json(updated);
  });

  router.post("/onboarding/draft/complete", async (req, res) => {
    assertBoard(req);
    const userId = requireUserId(req);
    const completed = await service.complete(userId);
    if (!completed) {
      res.status(409).json({ error: "no_active_draft" });
      return;
    }
    res.json(completed);
  });

  return router;
}
