import type { Db } from "@founderos/db";
import type { EmailSender } from "../services/email-sender.js";
import { buildWelcomeEmailText, buildWelcomeEmailHtml } from "../services/email-templates.js";
import { logger } from "../middleware/logger.js";

const WELCOME_SUBJECT = "Welcome to FounderOS — your AI company is ready to build";

export function createPostSignupHook(opts: {
  db: Db;
  emailSender: EmailSender;
  publicUrl: string;
}): (user: { id: string; email: string; name?: string | null }) => Promise<void> {
  const { db: _db, emailSender, publicUrl } = opts;

  return async function postSignupHook(user) {
    const firstName = user.name?.split(" ")[0]?.trim() || "there";
    const dashboardUrl = `${publicUrl}/dashboard`;

    const text = buildWelcomeEmailText({ firstName, dashboardUrl });
    const html = buildWelcomeEmailHtml({ firstName, dashboardUrl });

    // Log the signup event (not company-scoped — user has no company yet).
    logger.info({ userId: user.id, email: user.email }, "user.signup");

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
