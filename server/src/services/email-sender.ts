import { logger } from "../middleware/logger.js";

export interface EmailSendParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailSendResult = { ok: true; id: string } | { ok: false; error: string };

export interface EmailSender {
  send(params: EmailSendParams): Promise<EmailSendResult>;
  enabled: boolean;
}

export function createEmailSender(opts: {
  apiKey?: string;
  fromAddress?: string;
}): EmailSender {
  const { apiKey, fromAddress = "onboarding@resend.dev" } = opts;

  if (!apiKey) {
    return {
      enabled: false,
      async send(_params: EmailSendParams): Promise<EmailSendResult> {
        logger.info("email send skipped — RESEND_API_KEY not set");
        return { ok: false, error: "disabled" };
      },
    };
  }

  return {
    enabled: true,
    async send(params: EmailSendParams): Promise<EmailSendResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const body: Record<string, unknown> = {
          from: fromAddress,
          to: [params.to],
          subject: params.subject,
          text: params.text,
        };
        if (params.html) {
          body.html = params.html;
        }

        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "(unreadable)");
          return { ok: false, error: `HTTP ${response.status}: ${text}` };
        }

        const json = (await response.json()) as { id?: string };
        const id = json.id ?? "(no-id)";
        return { ok: true, id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
