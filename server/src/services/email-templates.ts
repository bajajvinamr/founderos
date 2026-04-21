export interface WelcomeEmailParams {
  firstName: string;
  dashboardUrl: string;
}

export function buildWelcomeEmailText(params: WelcomeEmailParams): string {
  const { firstName, dashboardUrl } = params;
  return [
    `Hey ${firstName},`,
    "",
    "Welcome to FounderOS. You just signed up for the AI company OS for solo founders.",
    "",
    "Here's what's next:",
    "1. Pick a starting team in the onboarding wizard",
    "2. Connect an AI provider (Claude, Codex, or Gemini)",
    "3. Write your company charter — your team reads it on every shift",
    "",
    `Open your dashboard → ${dashboardUrl}`,
    "",
    "Best,",
    "The FounderOS team",
  ].join("\n");
}

export function buildWelcomeEmailHtml(params: WelcomeEmailParams): string {
  const { firstName, dashboardUrl } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>Hey ${escapeHtml(firstName)},</p>
  <p>Welcome to FounderOS. You just signed up for the AI company OS for solo founders.</p>
  <p><strong>Here's what's next:</strong></p>
  <ol>
    <li>Pick a starting team in the onboarding wizard</li>
    <li>Connect an AI provider (Claude, Codex, or Gemini)</li>
    <li>Write your company charter — your team reads it on every shift</li>
  </ol>
  <p><a href="${escapeHtml(dashboardUrl)}">Open your dashboard →</a></p>
  <p>Best,<br>The FounderOS team</p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
