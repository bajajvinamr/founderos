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

// ---------------------------------------------------------------------------
// Wave 17A — Daily morning digest email
// ---------------------------------------------------------------------------

export interface PendingDecisionSummary {
  id: string;
  title: string;
  type: string;
  url: string | null;
  createdAt: Date;
}

export interface RecentRunSummary {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface FailingAgentSummary {
  agentId: string;
  agentName: string;
  lastFailureAt: Date | null;
  error: string | null;
}

export interface DailyDigestEmailParams {
  companyName: string;
  /** Already-localized date line, e.g. "Tuesday, April 21". */
  dateLine: string;
  pendingDecisions: PendingDecisionSummary[];
  pendingDecisionsTotal: number;
  recentRuns: RecentRunSummary[];
  failingAgents: FailingAgentSummary[];
  agentActions24h: number;
  costYesterdayCents: number;
  manageUrl: string;
  unsubscribeUrl: string;
}

function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRunWhen(startedAt: Date | null): string {
  if (!startedAt) return "pending";
  return startedAt.toISOString().replace("T", " ").replace(/\..*$/, " UTC");
}

export function buildDailyDigestEmailText(params: DailyDigestEmailParams): string {
  const {
    companyName,
    dateLine,
    pendingDecisions,
    pendingDecisionsTotal,
    recentRuns,
    failingAgents,
    agentActions24h,
    costYesterdayCents,
    manageUrl,
    unsubscribeUrl,
  } = params;

  const lines: string[] = [];
  lines.push(`${companyName} — ${dateLine}`);
  lines.push("");

  lines.push(`Decisions (${pendingDecisionsTotal} pending)`);
  if (pendingDecisions.length === 0) {
    lines.push("  No pending decisions. Nice.");
  } else {
    for (const d of pendingDecisions) {
      lines.push(`  - [${d.type}] ${d.title}${d.url ? ` → ${d.url}` : ""}`);
    }
    if (pendingDecisionsTotal > pendingDecisions.length) {
      lines.push(`  (+${pendingDecisionsTotal - pendingDecisions.length} more)`);
    }
  }
  lines.push("");

  lines.push(`Agent activity (${agentActions24h} actions in last 24h)`);
  if (recentRuns.length === 0) {
    lines.push("  No recent runs.");
  } else {
    for (const r of recentRuns) {
      lines.push(`  - ${r.agentName}: ${r.status} @ ${formatRunWhen(r.startedAt)}`);
    }
  }
  lines.push("");

  if (failingAgents.length > 0) {
    lines.push(`Failing agents (${failingAgents.length})`);
    for (const a of failingAgents) {
      const errBit = a.error ? ` — ${a.error.slice(0, 120)}` : "";
      lines.push(`  - ${a.agentName}${errBit}`);
    }
    lines.push("");
  }

  lines.push("Metrics");
  lines.push(`  Agent cost yesterday: ${formatCents(costYesterdayCents)}`);
  lines.push("");

  lines.push("—");
  lines.push("Daily digest from FounderOS");
  lines.push(`Manage notifications: ${manageUrl}`);
  lines.push(`Unsubscribe from this company: ${unsubscribeUrl}`);
  return lines.join("\n");
}

export function buildDailyDigestEmailHtml(params: DailyDigestEmailParams): string {
  const {
    companyName,
    dateLine,
    pendingDecisions,
    pendingDecisionsTotal,
    recentRuns,
    failingAgents,
    agentActions24h,
    costYesterdayCents,
    manageUrl,
    unsubscribeUrl,
  } = params;

  const decisionsHtml = pendingDecisions.length === 0
    ? `<p style="margin:0;color:#555">No pending decisions. Nice.</p>`
    : `<ul style="margin:0;padding-left:20px">${pendingDecisions
        .map((d) => {
          const title = escapeHtml(d.title);
          const type = escapeHtml(d.type);
          const link = d.url
            ? `<a href="${escapeHtml(d.url)}" style="color:#1a56db;text-decoration:none">${title}</a>`
            : title;
          return `<li style="margin:0 0 6px 0"><span style="display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#777;margin-right:6px">${type}</span>${link}</li>`;
        })
        .join("")}</ul>${
        pendingDecisionsTotal > pendingDecisions.length
          ? `<p style="margin:8px 0 0;color:#777;font-size:13px">+${pendingDecisionsTotal - pendingDecisions.length} more waiting</p>`
          : ""
      }`;

  const runsHtml = recentRuns.length === 0
    ? `<p style="margin:0;color:#555">No agent runs in the last 24h.</p>`
    : `<ul style="margin:0;padding-left:20px">${recentRuns
        .map((r) => {
          const status = escapeHtml(r.status);
          const dot = statusDot(r.status);
          return `<li style="margin:0 0 6px 0"><strong>${escapeHtml(r.agentName)}</strong> <span style="color:${dot.color}">● ${status}</span> <span style="color:#888;font-size:12px">${escapeHtml(formatRunWhen(r.startedAt))}</span></li>`;
        })
        .join("")}</ul>`;

  const failingHtml = failingAgents.length === 0
    ? ""
    : `<h2 style="font-size:15px;margin:24px 0 8px;color:#b42318">Needs attention (${failingAgents.length})</h2><ul style="margin:0;padding-left:20px">${failingAgents
        .map((a) => {
          const err = a.error ? ` — <span style="color:#b42318">${escapeHtml(a.error.slice(0, 160))}</span>` : "";
          return `<li style="margin:0 0 6px 0"><strong>${escapeHtml(a.agentName)}</strong>${err}</li>`;
        })
        .join("")}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f8">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f7f8">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #eee">
          <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.06em">${escapeHtml(dateLine)}</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${escapeHtml(companyName)}</div>
        </td></tr>

        <tr><td style="padding:20px 24px">
          <h2 style="font-size:15px;margin:0 0 8px;color:#111">Decisions (${pendingDecisionsTotal} pending)</h2>
          ${decisionsHtml}
        </td></tr>

        <tr><td style="padding:0 24px 20px">
          <h2 style="font-size:15px;margin:12px 0 8px;color:#111">Agent activity <span style="color:#888;font-weight:400;font-size:13px">· ${agentActions24h} actions / 24h</span></h2>
          ${runsHtml}
          ${failingHtml}
        </td></tr>

        <tr><td style="padding:0 24px 20px">
          <h2 style="font-size:15px;margin:12px 0 8px;color:#111">Metrics</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%">
            <tr>
              <td style="padding:10px 12px;background:#f9fafb;border-radius:8px">
                <div style="font-size:12px;color:#777">Agent cost yesterday</div>
                <div style="font-size:18px;font-weight:700;margin-top:2px">${formatCents(costYesterdayCents)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#888">
          Daily digest from FounderOS ·
          <a href="${escapeHtml(manageUrl)}" style="color:#555;text-decoration:underline">Manage notifications</a> ·
          <a href="${escapeHtml(unsubscribeUrl)}" style="color:#555;text-decoration:underline">Unsubscribe from this company</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function statusDot(status: string): { color: string } {
  switch (status) {
    case "succeeded":
      return { color: "#059669" };
    case "failed":
      return { color: "#b42318" };
    case "running":
      return { color: "#1a56db" };
    case "queued":
      return { color: "#b45309" };
    case "cancelled":
      return { color: "#6b7280" };
    default:
      return { color: "#6b7280" };
  }
}
