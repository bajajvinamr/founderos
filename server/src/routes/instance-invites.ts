import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@founderos/db";
import { authUsers, instanceUserRoles } from "@founderos/db";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceInviteService } from "../services/instance-invite.js";
import { createEmailSender, type EmailSender } from "../services/email-sender.js";
import { buildInviteEmailHtml, buildInviteEmailText } from "../services/email-templates.js";
import { logger } from "../middleware/logger.js";

function assertCanManageInvites(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

const createInviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["instance_admin", "instance_member"]).default("instance_member"),
});

export interface InstanceInvitesRoutesOptions {
  emailSender?: EmailSender;
  publicUrl?: string;
}

export function instanceInvitesRoutes(
  db: Db,
  opts: InstanceInvitesRoutesOptions = {},
) {
  const router = Router();
  const svc = instanceInviteService(db);
  const emailSender: EmailSender =
    opts.emailSender ??
    createEmailSender({
      apiKey: process.env.RESEND_API_KEY,
      fromAddress: process.env.EMAIL_FROM,
    });

  /**
   * GET /api/instance/invites
   * List pending invites. Instance admin only.
   */
  router.get("/instance/invites", async (req, res) => {
    assertCanManageInvites(req);
    const invites = await svc.listInvites();
    // Never leak the raw token in list responses; admin can revoke + re-issue.
    res.json(
      invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        createdBy: invite.createdBy,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      })),
    );
  });

  /**
   * POST /api/instance/invites
   * Create an email invite + (best-effort) send the signup link.
   * Body: { email, role? }
   */
  router.post("/instance/invites", validate(createInviteSchema), async (req, res) => {
    assertCanManageInvites(req);
    const email: string = req.body.email;
    const role: "instance_admin" | "instance_member" = req.body.role;

    const creatorUserId = req.actor.userId ?? "unknown";
    const created = await svc.createInvite({
      email,
      role,
      createdBy: creatorUserId,
    });

    // Best-effort email send. Never block invite creation on email failure
    // — the admin can always copy the signup URL from the response.
    const publicUrl = opts.publicUrl ?? process.env.FOUNDEROS_PUBLIC_URL ?? "";
    const signupUrl = publicUrl
      ? `${publicUrl.replace(/\/$/, "")}/auth?invite=${encodeURIComponent(created.token)}`
      : `/auth?invite=${encodeURIComponent(created.token)}`;

    let inviterName: string | null = null;
    if (req.actor.type === "board" && req.actor.userId) {
      const inviter = await db
        .select({ name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, req.actor.userId))
        .then((rows) => rows[0] ?? null);
      inviterName = inviter?.name ?? inviter?.email ?? null;
    }

    if (emailSender.enabled) {
      try {
        const text = buildInviteEmailText({
          inviterName,
          role,
          signupUrl,
        });
        const html = buildInviteEmailHtml({
          inviterName,
          role,
          signupUrl,
        });
        const subject = inviterName
          ? `${inviterName} invited you to FounderOS`
          : "You're invited to FounderOS";
        const result = await emailSender.send({
          to: email,
          subject,
          text,
          html,
        });
        if (!result.ok) {
          logger.warn(
            { to: email, error: result.error },
            "instance invite: email send failed (non-fatal)",
          );
        }
      } catch (err) {
        logger.warn({ err, to: email }, "instance invite: email send threw (non-fatal)");
      }
    } else {
      logger.info(
        { to: email, signupUrl },
        "instance invite: email sender disabled — admin must share signup URL manually",
      );
    }

    res.status(201).json({
      id: created.id,
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt,
      signupUrl,
    });
  });

  /**
   * DELETE /api/instance/invites/:id
   * Revoke (delete) a pending invite.
   */
  router.delete("/instance/invites/:id", async (req, res) => {
    assertCanManageInvites(req);
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      throw badRequest("invalid invite id");
    }
    await svc.revokeInvite(id);
    res.status(204).end();
  });

  /**
   * GET /api/instance/members
   * List current instance members — join of instance_user_roles ↔ user.
   * Any board user can read (same policy as /instance/settings/general).
   */
  router.get("/instance/members", async (req, res) => {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    const rows = await db
      .select({
        userId: instanceUserRoles.userId,
        role: instanceUserRoles.role,
        roleCreatedAt: instanceUserRoles.createdAt,
        name: authUsers.name,
        email: authUsers.email,
      })
      .from(instanceUserRoles)
      .leftJoin(authUsers, eq(authUsers.id, instanceUserRoles.userId));

    // Collapse duplicate user rows when a user has both roles; surface the
    // strongest role (admin > member).
    const byUser = new Map<string, {
      userId: string;
      role: string;
      name: string | null;
      email: string | null;
      roleCreatedAt: Date;
    }>();
    for (const row of rows) {
      const existing = byUser.get(row.userId);
      if (!existing) {
        byUser.set(row.userId, {
          userId: row.userId,
          role: row.role,
          name: row.name ?? null,
          email: row.email ?? null,
          roleCreatedAt: row.roleCreatedAt,
        });
        continue;
      }
      if (row.role === "instance_admin") {
        existing.role = "instance_admin";
      }
    }

    res.json(Array.from(byUser.values()));
  });

  return router;
}

// Re-export a helper used by tests / wiring that needs the service directly
// without wiring up the Express router.
export { instanceInviteService };
