import type { Db } from "@founderos/db";
import type { EmailSender } from "../services/email-sender.js";
import { buildWelcomeEmailText, buildWelcomeEmailHtml } from "../services/email-templates.js";
import { instanceInviteService } from "../services/instance-invite.js";
import { logger } from "../middleware/logger.js";

const WELCOME_SUBJECT = "Welcome to FounderOS — your AI company is ready to build";

export function createPostSignupHook(opts: {
  db: Db;
  emailSender: EmailSender;
  publicUrl: string;
}): (user: { id: string; email: string; name?: string | null }) => Promise<void> {
  const { db, emailSender, publicUrl } = opts;
  const invites = instanceInviteService(db);

  return async function postSignupHook(user) {
    const firstName = user.name?.split(" ")[0]?.trim() || "there";
    const dashboardUrl = `${publicUrl}/dashboard`;

    const text = buildWelcomeEmailText({ firstName, dashboardUrl });
    const html = buildWelcomeEmailHtml({ firstName, dashboardUrl });

    // Log the signup event (not company-scoped — user has no company yet).
    logger.info({ userId: user.id, email: user.email }, "user.signup");

    // Best-effort: auto-consume any pending instance invite for this email
    // so the new user lands on the right role (instance_admin or
    // instance_member) without manual DB surgery. Never throw — signup
    // must complete even if consume fails.
    try {
      const consumed = await invites.consumeInvite({ email: user.email, userId: user.id });
      if (consumed) {
        logger.info(
          { userId: user.id, email: user.email, role: consumed.role, inviteId: consumed.id },
          "post-signup hook: consumed instance invite",
        );
      }
    } catch (err) {
      logger.warn(
        { err, userId: user.id, email: user.email },
        "post-signup hook: consumeInvite failed (non-fatal)",
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
