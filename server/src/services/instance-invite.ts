import { randomBytes } from "node:crypto";
import type { Db } from "@founderos/db";
import { instanceInvites, instanceUserRoles } from "@founderos/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

/**
 * Instance-scoped invite flow.
 *
 * Solves the cofounder-onboarding gap: in authenticated mode the only way
 * to add a teammate was to manually insert an `instance_user_roles` row.
 * Now an admin creates an email invite, the teammate signs up, and the
 * post-signup hook (see server/src/auth/post-signup-hook.ts) consumes the
 * pending invite for their email and grants the target role.
 */

export type InviteRole = "instance_admin" | "instance_member";

const DEFAULT_TTL_HOURS = 24 * 7;

export type InstanceInvite = {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
};

type InviteRow = typeof instanceInvites.$inferSelect;

function toInvite(row: InviteRow): InstanceInvite {
  return {
    id: row.id,
    email: row.email,
    role: (row.role === "instance_admin" ? "instance_admin" : "instance_member") as InviteRole,
    token: row.token,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedBy: row.consumedBy,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateInviteToken(): string {
  // 32 bytes of entropy → 43 URL-safe base64 chars. Plenty for an invite
  // link signed only by unguessability.
  return randomBytes(32).toString("base64url");
}

export interface CreateInviteInput {
  email: string;
  role?: InviteRole;
  createdBy: string;
  ttlHours?: number;
}

export interface CreateInviteResult {
  id: string;
  token: string;
  expiresAt: Date;
  email: string;
  role: InviteRole;
}

export interface InstanceInviteService {
  createInvite(input: CreateInviteInput): Promise<CreateInviteResult>;
  consumeInvite(input: { email: string; userId: string }): Promise<InstanceInvite | null>;
  listInvites(): Promise<InstanceInvite[]>;
  revokeInvite(id: string): Promise<void>;
  findByToken(token: string): Promise<InstanceInvite | null>;
}

export function instanceInviteService(db: Db): InstanceInviteService {
  async function createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
    const email = normalizeEmail(input.email);
    if (!email) {
      throw new Error("email is required");
    }
    const role: InviteRole = input.role === "instance_admin" ? "instance_admin" : "instance_member";
    const ttlHours = input.ttlHours && input.ttlHours > 0 ? input.ttlHours : DEFAULT_TTL_HOURS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    const token = generateInviteToken();

    // If there's already a pending invite for this email, revoke it first
    // (delete it) so the partial unique index doesn't block the insert.
    // This also means re-inviting the same email rotates the token and
    // resets the role + TTL, which matches user expectations.
    await db
      .delete(instanceInvites)
      .where(and(eq(instanceInvites.email, email), isNull(instanceInvites.consumedAt)));

    const [row] = await db
      .insert(instanceInvites)
      .values({
        email,
        role,
        token,
        createdBy: input.createdBy,
        expiresAt,
      })
      .returning();

    if (!row) {
      throw new Error("failed to create invite");
    }

    return {
      id: row.id,
      token: row.token,
      expiresAt: row.expiresAt,
      email: row.email,
      role: (row.role === "instance_admin" ? "instance_admin" : "instance_member") as InviteRole,
    };
  }

  async function consumeInvite(input: { email: string; userId: string }): Promise<InstanceInvite | null> {
    const email = normalizeEmail(input.email);
    if (!email || !input.userId) return null;

    const now = new Date();

    // Find the latest pending, non-expired invite for this email.
    const rows = await db
      .select()
      .from(instanceInvites)
      .where(
        and(
          eq(instanceInvites.email, email),
          isNull(instanceInvites.consumedAt),
          gt(instanceInvites.expiresAt, now),
        ),
      )
      .orderBy(desc(instanceInvites.createdAt))
      .limit(1);

    const pending = rows[0];
    if (!pending) {
      // No pending invite, nothing to consume. This is a valid no-op: the
      // user may have signed up organically (e.g. first admin bootstrap).
      return null;
    }

    // Mark consumed and grant role in the same transaction where possible.
    // drizzle's `transaction` is available on postgres-js driver; we call
    // operations sequentially and tolerate partial failures via logging.
    const [updated] = await db
      .update(instanceInvites)
      .set({
        consumedAt: now,
        consumedBy: input.userId,
      })
      .where(and(eq(instanceInvites.id, pending.id), isNull(instanceInvites.consumedAt)))
      .returning();

    if (!updated) {
      // Another concurrent consume won the race. Treat as no-op — the
      // competing flow already granted the role.
      return null;
    }

    // Grant the instance role. Upsert-ish: the unique index on
    // (user_id, role) makes duplicate grants harmless.
    const existing = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, input.userId), eq(instanceUserRoles.role, updated.role)))
      .then((r) => r[0] ?? null);

    if (!existing) {
      try {
        await db.insert(instanceUserRoles).values({
          userId: input.userId,
          role: updated.role,
        });
      } catch (err) {
        logger.warn(
          { err, userId: input.userId, role: updated.role },
          "instance-invite: failed to insert instance_user_roles row (race or constraint — continuing)",
        );
      }
    }

    return toInvite(updated);
  }

  async function listInvites(): Promise<InstanceInvite[]> {
    const rows = await db
      .select()
      .from(instanceInvites)
      .where(isNull(instanceInvites.consumedAt))
      .orderBy(desc(instanceInvites.createdAt));
    return rows.map(toInvite);
  }

  async function revokeInvite(id: string): Promise<void> {
    await db.delete(instanceInvites).where(eq(instanceInvites.id, id));
  }

  async function findByToken(token: string): Promise<InstanceInvite | null> {
    const rows = await db.select().from(instanceInvites).where(eq(instanceInvites.token, token)).limit(1);
    return rows[0] ? toInvite(rows[0]) : null;
  }

  return {
    createInvite,
    consumeInvite,
    listInvites,
    revokeInvite,
    findByToken,
  };
}
