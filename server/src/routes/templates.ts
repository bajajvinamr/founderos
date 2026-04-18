import { Router } from "express";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { listTemplateSummaries, getTemplate } from "@founderos/templates";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  templateSpawnService,
  companyService,
  logActivity,
  getProviderCredentialReport,
  getProviderAvailability,
  instanceApiKeysService,
  templateExportService,
  type ProviderStrategy,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

const setProviderKeySchema = z.object({
  family: z.enum(["anthropic", "openai", "google"]),
  executionMode: z.enum(["api", "cli_oauth"]).optional(),
  value: z.string().min(4).max(10_000),
});

const providerStrategySchema = z.union([
  z.literal("mixed"),
  z.literal("anthropic_first"),
  z.literal("openai_first"),
  z.literal("google_first"),
  z.object({
    kind: z.literal("override"),
    adapterType: z.enum([
      "claude_local",
      "claude_api",
      "codex_local",
      "openai_api",
      "gemini_local",
      "cursor_local",
      "opencode_local",
      "openclaw_gateway",
    ]),
    model: z.string().min(1).max(100),
  }),
]);

const spawnTemplateSchema = z.object({
  templateId: z.string().min(1).max(100),
  companyName: z.string().min(1).max(200).optional(),
  providerStrategy: providerStrategySchema.optional(),
  agentOverrides: z
    .record(
      z.string(),
      z.object({
        budgetUsd: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export function templateRoutes(db: Db) {
  const router = Router();
  const spawner = templateSpawnService(db);
  const companies = companyService(db);
  const apiKeys = instanceApiKeysService(db);
  const exporter = templateExportService(db);

  /**
   * List all built-in templates (summary shape — enough for the picker).
   * Does not require a selected company; any authenticated board user can see.
   */
  router.get("/templates", (req, res) => {
    assertBoard(req);
    res.json(listTemplateSummaries());
  });

  /**
   * Report which AI providers this instance has credentials for. Powers the
   * "AI Providers" settings page + the enablement state of strategy radio
   * buttons in the spawn flow.
   */
  router.get("/providers", async (req, res) => {
    assertBoard(req);
    const stored = await apiKeys.listConfiguredFamilies();
    const report = getProviderCredentialReport(stored);
    const availability = getProviderAvailability(stored);
    const storedKeys = await apiKeys.listKeys();
    res.json({
      availability,
      providers: report,
      storedKeys: storedKeys.map((k) => ({
        family: k.family,
        executionMode: k.executionMode,
        keyHint: k.keyHint,
        updatedAt: k.updatedAt,
      })),
    });
  });

  /**
   * Save or overwrite an API key for a provider. Only instance admins can
   * touch these since they affect every company on the instance. Values are
   * encrypted with the local master key and never returned raw.
   */
  router.post(
    "/providers/keys",
    validate(setProviderKeySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const body = req.body as z.infer<typeof setProviderKeySchema>;
      const stored = await apiKeys.setKey({
        family: body.family,
        executionMode: body.executionMode ?? "api",
        value: body.value,
      });
      res.json({
        family: stored.family,
        executionMode: stored.executionMode,
        keyHint: stored.keyHint,
        updatedAt: stored.updatedAt,
      });
    },
  );

  /**
   * Export a company as a reusable CompanyTemplate JSON. Output can be
   * replayed through /api/templates/spawn to produce a fresh copy.
   * Heartbeat runs, cost events, and API keys are stripped.
   */
  router.get("/companies/:companyId/template-export", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const template = await exporter.exportCompany(req.params.companyId);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${template.id}.template.json"`,
    );
    res.json(template);
  });

  router.delete("/providers/keys/:family/:mode", async (req, res) => {
    assertInstanceAdmin(req);
    const family = req.params.family;
    const mode = req.params.mode;
    if (family !== "anthropic" && family !== "openai" && family !== "google") {
      throw notFound("Unknown provider family");
    }
    if (mode !== "api" && mode !== "cli_oauth") {
      throw notFound("Unknown execution mode");
    }
    const deleted = await apiKeys.deleteKey(family, mode);
    if (!deleted) throw notFound("No key stored for this provider + mode");
    res.status(204).end();
  });

  /**
   * Get one template in full detail (agents, goals, projects, issues).
   * Used by the onboarding detail view before the user clicks Spawn.
   */
  router.get("/templates/:id", (req, res) => {
    assertBoard(req);
    const t = getTemplate(req.params.id);
    if (!t) throw notFound(`Template not found: ${req.params.id}`);
    res.json(t);
  });

  /**
   * Spawn a new company from a template. Creates the company + membership
   * linking the current user as owner + full agent / goal / project / issue
   * roster in a single transaction.
   */
  router.post(
    "/templates/spawn",
    validate(spawnTemplateSchema),
    async (req, res) => {
      assertBoard(req);
      const ownerUserId = req.actor.userId;
      if (!ownerUserId) throw forbidden("User identity required to spawn company");

      const body = req.body as z.infer<typeof spawnTemplateSchema>;
      const result = await spawner.spawn({
        templateId: body.templateId,
        companyName: body.companyName,
        ownerUserId,
        providerStrategy: body.providerStrategy as ProviderStrategy | undefined,
        agentOverrides: body.agentOverrides,
      });

      // Return the freshly created company so the UI can switch to it.
      const company = await companies.getById(result.companyId);
      if (!company) throw notFound("Company missing after spawn");

      await logActivity(db, {
        companyId: result.companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "company.spawned_from_template",
        entityType: "company",
        entityId: result.companyId,
        details: {
          templateId: result.templateId,
          agentsCreated: result.agentsCreated,
          goalsCreated: result.goalsCreated,
          projectsCreated: result.projectsCreated,
          issuesCreated: result.issuesCreated,
        },
      });

      res.status(201).json({ ...result, company });
    },
  );

  return router;
}
