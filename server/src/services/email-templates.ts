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

export interface InviteEmailParams {
  inviterName: string | null;
  role: "instance_admin" | "instance_member";
  signupUrl: string;
}

function roleLabel(role: InviteEmailParams["role"]): string {
  return role === "instance_admin" ? "instance admin" : "teammate";
}

export function buildInviteEmailText(params: InviteEmailParams): string {
  const { inviterName, role, signupUrl } = params;
  const who = inviterName?.trim() || "Someone on your team";
  return [
    `${who} invited you to FounderOS as an ${roleLabel(role)}.`,
    "",
    "FounderOS is the AI company OS for founders — a home for your AI teammates, shared context, and shipped work.",
    "",
    `Accept the invite → ${signupUrl}`,
    "",
    "This link will auto-grant you the right role as soon as you finish signing up.",
    "",
    "— The FounderOS team",
  ].join("\n");
}

export function buildInviteEmailHtml(params: InviteEmailParams): string {
  const { inviterName, role, signupUrl } = params;
  const who = escapeHtml(inviterName?.trim() || "Someone on your team");
  const url = escapeHtml(signupUrl);
  const roleText = escapeHtml(roleLabel(role));
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <p>${who} invited you to FounderOS as an <strong>${roleText}</strong>.</p>
  <p>FounderOS is the AI company OS for founders — a home for your AI teammates, shared context, and shipped work.</p>
  <p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">Accept the invite →</a></p>
  <p style="font-size:12px;color:#666">This link will auto-grant you the right role as soon as you finish signing up.</p>
  <p>— The FounderOS team</p>
</body>
</html>`;
}
