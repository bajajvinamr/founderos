import { eq } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { instanceUserRoles } from "@founderos/db";
import type { EmailSender } from "../services/email-sender.js";
import { buildWelcomeEmailText, buildWelcomeEmailHtml } from "../services/email-templates.js";
import { instanceInviteService } from "../services/instance-invite.js";
import { logger } from "../middleware/logger.js";

const WELCOME_SUBJECT = "Welcome to FounderOS — your AI company is ready to build";
const LOCAL_BOARD_USER_ID = "local-board";

export interface PostSignupBootstrapResult {
  /**
   * Whether this signup was promoted to instance_admin via the "first user
   * wins" bootstrap rule (zero pre-existing human admins).
   */
  promotedToInstanceAdmin: boolean;
  /** Whether a pending invite was found + consumed for this email. */
  consumedInvite:
    | { id: string; role: "instance_admin" | "instance_member" }
    | null;
}

/**
 * Reusable post-signup bootstrap.
 *
 * Runs when a new user account appears — either via better-auth's `user.create`
 * hook OR via the Supabase `user.created` webhook. Idempotent: safe to re-run
 * (duplicate role grants are a no-op thanks to the `(user_id, role)` unique
 * index, and invite consume short-circuits once consumedAt is set).
 *
 * Behavior:
 *   1. If no pending invite exists for this email AND there are currently
 *      zero non-local-board `instance_admin` rows, promote this user to
 *      `instance_admin`. This is the "first user wins" bootstrap — it lets
 *      a fresh deployment claim itself without DB surgery.
 *   2. Otherwise, try to consume a pending invite for this email — that path
 *      already grants the correct role (admin or member).
 *
 * Errors are logged and swallowed. Signup must complete even if downstream
 * bootstrap bookkeeping fails.
 */
export async function runPostSignupBootstrap(
  db: Db,
  input: { userId: string; email: string },
): Promise<PostSignupBootstrapResult> {
  const result: PostSignupBootstrapResult = {
    promotedToInstanceAdmin: false,
    consumedInvite: null,
  };

  const invites = instanceInviteService(db);

  // Best-effort invite consume first — an explicit invite wins over the
  // first-user-wins rule (admin invited a member explicitly as member, etc.).
  try {
    const consumed = await invites.consumeInvite({ email: input.email, userId: input.userId });
    if (consumed) {
      result.consumedInvite = {
        id: consumed.id,
        role: consumed.role,
      };
      logger.info(
        { userId: input.userId, email: input.email, role: consumed.role, inviteId: consumed.id },
        "post-signup bootstrap: consumed instance invite",
      );
    }
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, email: input.email },
      "post-signup bootstrap: consumeInvite failed (non-fatal)",
    );
  }

  // If no invite was consumed, apply first-user-wins. A deployment that
  // already has a human instance_admin (anything other than the implicit
  // local-board principal) is NOT bootstrapping — subsequent signups should
  // not auto-promote.
  if (!result.consumedInvite) {
    try {
      const admins = await db
        .select({ userId: instanceUserRoles.userId })
        .from(instanceUserRoles)
        .where(eq(instanceUserRoles.role, "instance_admin"));

      const hasHumanAdmin = admins.some((row) => row.userId !== LOCAL_BOARD_USER_ID);
      if (!hasHumanAdmin) {
        try {
          await db.insert(instanceUserRoles).values({
            userId: input.userId,
            role: "instance_admin",
          });
          result.promotedToInstanceAdmin = true;
          logger.info(
            { userId: input.userId, email: input.email },
            "post-signup bootstrap: promoted first user to instance_admin",
          );
        } catch (err) {
          // Likely a race against another signup or manual seed — the
          // unique index on (user_id, role) makes duplicate insert safe to
          // ignore.
          logger.warn(
            { err, userId: input.userId, email: input.email },
            "post-signup bootstrap: instance_admin insert failed (race or duplicate — continuing)",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, userId: input.userId, email: input.email },
        "post-signup bootstrap: admin count query failed (non-fatal)",
      );
    }
  }

  return result;
}

export function createPostSignupHook(opts: {
  db: Db;
  emailSender: EmailSender;
  publicUrl: string;
}): (user: { id: string; email: string; name?: string | null }) => Promise<void> {
  const { db, emailSender, publicUrl } = opts;

  return async function postSignupHook(user) {
    const firstName = user.name?.split(" ")[0]?.trim() || "there";
    const dashboardUrl = `${publicUrl}/dashboard`;

    const text = buildWelcomeEmailText({ firstName, dashboardUrl });
    const html = buildWelcomeEmailHtml({ firstName, dashboardUrl });

    // Log the signup event (not company-scoped — user has no company yet).
    logger.info({ userId: user.id, email: user.email }, "user.signup");

    // Run the shared bootstrap (invite consume + first-user-wins admin grant).
    // Never throw — signup must complete even if bootstrap bookkeeping fails.
    try {
      await runPostSignupBootstrap(db, { userId: user.id, email: user.email });
    } catch (err) {
      logger.warn(
        { err, userId: user.id, email: user.email },
        "post-signup hook: runPostSignupBootstrap failed (non-fatal)",
      );
    }

    if (!emailSender.enabled) {
      logger.debug({ userId: user.id }, "post-signup hook: email sender disabled, skipping welcome email");
      return;
    }

    const result = await emailSender.send({
      to: user.email,
      subject: WELCOME_SUBJECT,
      text,
      html,
    });

    if (result.ok) {
      logger.info(
        { userId: user.id, to: user.email, subject: WELCOME_SUBJECT, resendId: result.id },
        "email.welcome_sent",
      );
    } else {
      logger.warn(
        { userId: user.id, to: user.email, error: result.error },
        "post-signup hook: welcome email send failed (non-fatal)",
      );
    }
  };
}
