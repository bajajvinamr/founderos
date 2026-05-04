/**
 * Skill: `hubspot.create_contact`
 *
 * Creates a CRM contact in HubSpot on behalf of an agent, gated by the
 * agent's permission level. Wraps `createHubspotClient().createContact`.
 *
 * Permission semantics (mirrors `slack.post_message` and `permission-tool-gate.ts`):
 *   - `observe`    → skill throws; nothing is written.
 *   - `draft`      → no external call; creates a `pending_approval` row.
 *   - `approve`    → same as `draft` — pending approval; no immediate write.
 *   - `autonomous` → creates the contact immediately via HubSpot; logs
 *                    `hubspot.create_contact_executed` on success and
 *                    `hubspot.create_contact_failed` on error.
 *
 * The skill is company-scoped: it looks up the company's connected HubSpot
 * integration by kind (`hubspot`) and decrypts the access token. If no
 * integration is connected, the skill returns `{ ok: false, reason:
 * "no_integration" }` — caller treats this as a no-op.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { integrations, approvals } from "@founderos/db";
import type { AgentPermissionLevel } from "@founderos/shared";
import { createHubspotClient, HubspotAuthError } from "../hubspot-client.js";
import { logActivity } from "../activity-log.js";
import { decryptWithMasterKey } from "../../secrets/local-encrypted-provider.js";
import { logger } from "../../middleware/logger.js";
import {
  evaluateComposioRoute,
  runComposioTool,
} from "./composio-skill-bridge.js";

/** Public skill name exposed to agents. */
export const HUBSPOT_CREATE_CONTACT_SKILL_NAME = "hubspot.create_contact" as const;

export interface HubspotCreateContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
}

export interface HubspotCreateContactContext {
  db: Db;
  companyId: string;
  /** Permission level of the calling agent. */
  permissionLevel: AgentPermissionLevel;
  /** The agent making the call (optional but required for audit attribution). */
  agentId?: string | null;
  /** Optional run ID for tracing. */
  runId?: string | null;
  /** Wave 21: FounderOS user id for Composio routing. Optional. */
  userId?: string | null;
}

export type HubspotCreateContactResult =
  | { ok: true; status: "created"; contactId: string; url: string }
  | { ok: true; status: "pending_approval"; approvalId: string }
  | { ok: false; reason: "no_integration"; message: string }
  | { ok: false; reason: "hubspot_error"; message: string }
  | { ok: false; reason: "composio_error"; message: string };

// Rough RFC-5322 compatible email check — we only need to reject obviously bad
// input here; HubSpot will do its own validation and return 4xx if malformed.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInput(input: HubspotCreateContactInput): void {
  if (typeof input.email !== "string" || input.email.trim().length === 0) {
    throw new Error("hubspot.create_contact: `email` is required");
  }
  if (!EMAIL_REGEX.test(input.email.trim())) {
    throw new Error("hubspot.create_contact: `email` is not a valid email address");
  }
  for (const key of ["firstName", "lastName", "company", "phone"] as const) {
    const v = input[key];
    if (v !== undefined && typeof v !== "string") {
      throw new Error(`hubspot.create_contact: \`${key}\` must be a string when provided`);
    }
  }
}

async function createPendingApproval(params: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  input: HubspotCreateContactInput;
  integrationId: string;
}): Promise<string> {
  const { db, companyId, agentId, input, integrationId } = params;
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "hubspot.create_contact",
      requestedByAgentId: agentId ?? null,
      status: "pending",
      payload: {
        skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
        integrationId,
        email: input.email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        company: input.company ?? null,
        phone: input.phone ?? null,
      },
    })
    .returning({ id: approvals.id });
  return row.id;
}

function contactUrl(contactId: string): string {
  // HubSpot record UI URL pattern. portal ID isn't known here, so we link to
  // the generic record path which the HubSpot UI redirects to the right portal.
  return `https://app.hubspot.com/contacts/_/contact/${encodeURIComponent(contactId)}`;
}

/**
 * Execute the `hubspot.create_contact` skill.
 *
 * Does NOT throw on expected business outcomes (no integration, HubSpot API
 * errors). DOES throw on permission denial (`observe`) and on invalid input.
 */
export async function executeHubspotCreateContact(
  ctx: HubspotCreateContactContext,
  input: HubspotCreateContactInput,
): Promise<HubspotCreateContactResult> {
  validateInput(input);

  const { db, companyId, permissionLevel, agentId, runId, userId } = ctx;

  // ── Permission: observe ────────────────────────────────────────────────
  if (permissionLevel === "observe") {
    throw new Error(
      `Observe mode: skill "${HUBSPOT_CREATE_CONTACT_SKILL_NAME}" is not permitted`,
    );
  }

  // ── Wave 21: Composio routing (autonomous only) ────────────────────────
  if (permissionLevel === "autonomous" && userId) {
    const route = await evaluateComposioRoute({
      db,
      companyId,
      userId,
      appName: "hubspot",
    });
    if (route.shouldUse) {
      const composioOutcome = await runComposioTool({
        userId,
        connectedAccountId: route.composioConnectionId,
        toolName: "hubspot_create_contact",
        input: {
          email: input.email,
          firstname: input.firstName,
          lastname: input.lastName,
          company: input.company,
          phone: input.phone,
        },
      });
      if (composioOutcome.ok) {
        const contactId =
          typeof composioOutcome.output?.id === "string"
            ? (composioOutcome.output.id as string)
            : typeof composioOutcome.output?.contactId === "string"
              ? (composioOutcome.output.contactId as string)
              : "";
        await logActivity(db, {
          companyId,
          actorType: agentId ? "agent" : "system",
          actorId: agentId ?? "system",
          agentId: agentId ?? null,
          runId: runId ?? null,
          action: "hubspot.create_contact_executed",
          entityType: "integration",
          entityId: route.composioConnectionId ?? "composio",
          details: {
            skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
            contactId,
            email: input.email,
            permissionLevel,
            via: "composio",
          },
        }).catch(() => {});
        return {
          ok: true,
          status: "created",
          contactId,
          url: contactUrl(contactId),
        };
      }
      await logActivity(db, {
        companyId,
        actorType: agentId ? "agent" : "system",
        actorId: agentId ?? "system",
        agentId: agentId ?? null,
        runId: runId ?? null,
        action: "hubspot.create_contact_failed",
        entityType: "integration",
        entityId: route.composioConnectionId ?? "composio",
        details: {
          skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
          email: input.email,
          error: composioOutcome.message,
          via: "composio",
        },
      }).catch(() => {});
      return {
        ok: false,
        reason: "composio_error",
        message: composioOutcome.message,
      };
    }
  }

  // ── Look up company's HubSpot integration ──────────────────────────────
  const [integrationRow] = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.companyId, companyId),
        eq(integrations.kind, "hubspot"),
      ),
    );

  if (!integrationRow) {
    return {
      ok: false,
      reason: "no_integration",
      message: "HubSpot integration is not connected for this company",
    };
  }

  // ── Permission: draft / approve → create pending approval ──────────────
  if (permissionLevel === "draft" || permissionLevel === "approve") {
    const approvalId = await createPendingApproval({
      db,
      companyId,
      agentId,
      input,
      integrationId: integrationRow.id,
    });

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.create_contact_pending_approval",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
        approvalId,
        email: input.email,
        permissionLevel,
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, approvalId },
        "hubspot-create-contact: failed to log pending approval activity",
      );
    });

    return {
      ok: true,
      status: "pending_approval",
      approvalId,
    };
  }

  // ── Permission: autonomous → create immediately ────────────────────────
  if (permissionLevel !== "autonomous") {
    throw new Error(
      `Unknown permission level "${permissionLevel}" for skill "${HUBSPOT_CREATE_CONTACT_SKILL_NAME}"`,
    );
  }

  if (!integrationRow.encryptedApiKey) {
    return {
      ok: false,
      reason: "no_integration",
      message: "HubSpot integration is missing its access token",
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptWithMasterKey(integrationRow.encryptedApiKey);
  } catch (err) {
    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      "hubspot-create-contact: failed to decrypt access token",
    );
    return {
      ok: false,
      reason: "hubspot_error",
      message: "Failed to decrypt HubSpot access token",
    };
  }

  const client = createHubspotClient({ accessToken });

  try {
    const contact = await client.createContact(input);

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.create_contact_executed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
        contactId: contact.id,
        email: input.email,
        permissionLevel,
        via: "native",
      },
    }).catch((err) => {
      logger.error(
        { err, companyId, integrationId: integrationRow.id },
        "hubspot-create-contact: failed to log audit entry",
      );
    });

    return {
      ok: true,
      status: "created",
      contactId: contact.id,
      url: contactUrl(contact.id),
    };
  } catch (err: unknown) {
    const message =
      err instanceof HubspotAuthError
        ? "HubSpot access token is invalid or expired"
        : err instanceof Error
          ? err.message
          : "Unknown HubSpot error";

    await logActivity(db, {
      companyId,
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "system",
      agentId: agentId ?? null,
      runId: runId ?? null,
      action: "hubspot.create_contact_failed",
      entityType: "integration",
      entityId: integrationRow.id,
      details: {
        skill: HUBSPOT_CREATE_CONTACT_SKILL_NAME,
        email: input.email,
        error: message,
      },
    }).catch(() => {});

    logger.error(
      { err, companyId, integrationId: integrationRow.id },
      `hubspot-create-contact: createContact failed — ${message}`,
    );

    return { ok: false, reason: "hubspot_error", message };
  }
}
