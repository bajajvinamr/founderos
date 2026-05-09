/**
 * P0.6 — Company state export.
 *
 * Read-only JSON export of a company's user-visible state — the path the
 * Landing FAQ has historically promised. This is intentionally simpler
 * than the existing portability bundle (POST /api/companies/:id/export
 * via companyPortabilityService) which produces a structured backup
 * package for re-import. This endpoint produces a single JSON document
 * sized for "download my data" rather than backup/restore.
 *
 * Critical security property: SECRET REDACTION.
 *   Every result row is recursively walked before serialization. Any
 *   field whose name matches REDACTED_FIELDS is replaced with the
 *   literal string "[REDACTED]". The walker matches on EXACT field
 *   name (case-sensitive). Encrypted-at-rest material in the DB is
 *   never even read into memory by the queries below — the
 *   integrations select explicitly excludes `encryptedApiKey`.
 *
 * Cross-tenant access intentionally returns 404 (not 403) to avoid
 * companyId enumeration leakage — same anti-enumeration shape as the
 * notifications mark-read route.
 */

import { Router } from "express";
import { and, desc, eq, gte, or, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  agents,
  companies,
  companyMemory,
  goals,
  heartbeatRuns,
  integrations,
  notifications,
  projects,
} from "@founderos/db";
import { actorCanAccessCompany } from "./authz.js";
import { unauthorized } from "../errors.js";

/**
 * Field names whose VALUE is replaced with "[REDACTED]" anywhere it
 * appears in the export tree. Match is case-sensitive on the exact key
 * name — "secret" is redacted; "secrets" / "mysecret" / "publicSecret"
 * are NOT (substring matching is too easy to abuse: a column called
 * "tokens_used" or "password_changed_at" would lose unrelated values).
 *
 * If you add a new column anywhere in the schema that holds secret
 * material, add the field name here. The redaction guard is the last
 * line of defense — column-level select exclusion is the first.
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  "api_key",
  "apiKey",
  "client_secret",
  "clientSecret",
  "password",
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "credentials",
  "stripe_secret_key",
  "stripeSecretKey",
  "secret",
  "encrypted_api_key",
  "encryptedApiKey",
]);

const REDACTION_DEPTH_LIMIT = 10;
const REDACTED_VALUE = "[REDACTED]";

/**
 * Recursively replace any value whose KEY matches REDACTED_FIELDS with
 * the literal string "[REDACTED]". Walks plain objects + arrays. Stops
 * at REDACTION_DEPTH_LIMIT to prevent stack overflow on cyclic refs.
 *
 * Date / Buffer / null / primitives pass through unchanged. The walker
 * is non-mutating — it produces a new tree.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth >= REDACTION_DEPTH_LIMIT) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  // Date instances: pass through unchanged. JSON.stringify handles
  // them correctly via .toJSON(); recursing into their internals
  // would expose nothing useful.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_FIELDS.has(key)) {
      result[key] = REDACTED_VALUE;
    } else {
      result[key] = redactSecrets(child, depth + 1);
    }
  }
  return result as unknown as T;
}

function slugifyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 60) || "company";
}

function todayUtcStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ninetyDaysAgo(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 90);
  return d;
}

function thirtyDaysAgo(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 30);
  return d;
}

/**
 * GET /api/companies/:companyId/export
 *
 * Auth: any actor that has access to companyId via actorCanAccessCompany.
 * Returns 401 if no actor; 404 if the actor cannot access the companyId
 * (anti-enumeration); 404 if the company id resolves to no row.
 */
export function companiesExportRoutes(db: Db) {
  const router = Router();

  router.get("/:companyId/export", async (req, res) => {
    if (req.actor.type === "none") {
      throw unauthorized();
    }
    const companyId = req.params.companyId as string;

    // Anti-enumeration: cross-tenant access must look identical to a
    // missing-company-id response. Do NOT branch the error message.
    if (!actorCanAccessCompany(req, companyId)) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const [companyRow] = await db
      .select({
        id: companies.id,
        name: companies.name,
        description: companies.description,
        status: companies.status,
        brandColor: companies.brandColor,
        physicalAddress: companies.physicalAddress,
        supportEmail: companies.supportEmail,
        metrics: companies.metrics,
        isDemo: companies.isDemo,
        createdAt: companies.createdAt,
        updatedAt: companies.updatedAt,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!companyRow) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const goalRows = await db
      .select({
        id: goals.id,
        companyId: goals.companyId,
        title: goals.title,
        description: goals.description,
        level: goals.level,
        status: goals.status,
        parentId: goals.parentId,
        ownerAgentId: goals.ownerAgentId,
        createdAt: goals.createdAt,
        updatedAt: goals.updatedAt,
      })
      .from(goals)
      .where(eq(goals.companyId, companyId));

    const projectRows = await db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        goalId: projects.goalId,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        leadAgentId: projects.leadAgentId,
        targetDate: projects.targetDate,
        color: projects.color,
        archivedAt: projects.archivedAt,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.companyId, companyId));

    // Agents: include config + adapter type (the user-visible knobs)
    // but NOT runtime state, runtime credentials, or last_heartbeat
    // PIDs. adapterConfig still walks redactSecrets in case any
    // historical row tucked a key in there.
    const agentRows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        icon: agents.icon,
        status: agents.status,
        reportsTo: agents.reportsTo,
        capabilities: agents.capabilities,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        permissionLevel: agents.permissionLevel,
        permissions: agents.permissions,
        budgetMonthlyCents: agents.budgetMonthlyCents,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const memoryRows = await db
      .select({
        id: companyMemory.id,
        companyId: companyMemory.companyId,
        kind: companyMemory.kind,
        title: companyMemory.title,
        body: companyMemory.body,
        topic: companyMemory.topic,
        category: companyMemory.category,
        pinned: companyMemory.pinned,
        source: companyMemory.source,
        occurredAt: companyMemory.occurredAt,
        createdAt: companyMemory.createdAt,
        updatedAt: companyMemory.updatedAt,
      })
      .from(companyMemory)
      .where(eq(companyMemory.companyId, companyId));

    // Integrations: ONLY connector type + status + connection state.
    // Never include encryptedApiKey or config (which can contain
    // workspace IDs / OAuth account IDs / refresh tokens). The select
    // is the first defense; the redaction walker is the second.
    const integrationRows = await db
      .select({
        id: integrations.id,
        companyId: integrations.companyId,
        kind: integrations.kind,
        status: integrations.status,
        keyHint: integrations.keyHint,
        connectedAt: integrations.connectedAt,
        lastError: integrations.lastError,
        createdAt: integrations.createdAt,
        updatedAt: integrations.updatedAt,
      })
      .from(integrations)
      .where(eq(integrations.companyId, companyId));

    // Agent runs (heartbeat_runs): last 90 days, capped at 1000. Basic
    // fields only — no contextSnapshot, no resultJson, no usageJson.
    // Those fields can carry user-prompt content and provider response
    // text that a founder may not want to redistribute. Keep this
    // export safe to share.
    const runWindowStart = ninetyDaysAgo();
    const agentRunRows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gte(heartbeatRuns.createdAt, runWindowStart),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1000);

    // Notifications: last 90 days unread + last 30 days read. The
    // OR keeps the query a single round-trip; LIMIT bounds the worst
    // case. Cap at 100 per spec.
    const unreadFloor = ninetyDaysAgo();
    const readFloor = thirtyDaysAgo();
    const notificationRows = await db
      .select({
        id: notifications.id,
        companyId: notifications.companyId,
        userId: notifications.userId,
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        refKind: notifications.refKind,
        refId: notifications.refId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, companyId),
          or(
            and(isNull(notifications.readAt), gte(notifications.createdAt, unreadFloor)),
            and(isNotNull(notifications.readAt), gte(notifications.createdAt, readFloor)),
          ),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(100);

    const exportedAt = new Date().toISOString();
    const slug = slugifyName(companyRow.name);
    const dateStamp = todayUtcStamp();
    const filename = `founderos-export-${slug}-${dateStamp}.json`;

    const payload = redactSecrets({
      exportedAt,
      companyId,
      schemaVersion: "v1" as const,
      data: {
        company: companyRow,
        goals: goalRows,
        projects: projectRows,
        agents: agentRows,
        companyMemory: memoryRows,
        integrations: integrationRows,
        agentRuns: agentRunRows,
        notifications: notificationRows,
      },
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.status(200).send(JSON.stringify(payload, null, 2));
  });

  return router;
}
