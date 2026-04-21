import type { AgentPermissionLevel } from "../constants.js";

// ---------------------------------------------------------------------------
// Side-effect tool patterns
//
// Matched case-insensitively as substring of the tool name.
// Err on the side of catching more — if a tool name looks side-effecty,
// include it.
// ---------------------------------------------------------------------------

/**
 * Curated list of side-effect tool name patterns. Each entry is a
 * case-insensitive substring (or pipe-separated alternation) matched against
 * the tool name.
 */
export const SIDE_EFFECT_TOOL_PATTERNS: readonly string[] = [
  // Code + deploy
  "git_commit",
  "git_push",
  "npm_publish",
  "deploy",
  "fly_deploy",
  "kubectl_apply",
  "docker_push",
  "gh_pr_merge",
  "gh_release",
  // Shell side effects (write / destructive / network mutations)
  "write",
  "rm",
  "mv",
  // curl mutations — we check for curl + method suffix
  "curl_post",
  "curl_put",
  "curl_delete",
  // Content + messaging
  "slack_send",
  "slack_post",
  "send_email",
  "gmail_send",
  "resend_send",
  "hubspot_create",
  "hubspot_update",
  "linkedin_post",
  "twitter_post",
  "x_post",
  // Billing + finance
  "stripe",
  "payment",
  "refund",
  "subscribe",
  // Hiring, agents, config
  "create_agent",
  "terminate_agent",
  "update_agent",
  "set_permission",
  // Integrations
  "integration_create",
  "integration_delete",
  "oauth_revoke",
  // Generic side-effect verbs
  "publish",
  "send",
  "commit",
  "push",
  "release",
] as const;

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export interface EvaluateToolCallArgs {
  permissionLevel: AgentPermissionLevel;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface EvaluateToolCallResult {
  decision: "allow" | "block";
  reason: "ok" | "observe_level" | "draft_side_effect" | "approve_log";
  message?: string;
}

/**
 * Returns true when `toolName` matches any entry in SIDE_EFFECT_TOOL_PATTERNS.
 * Matching is case-insensitive substring / alternation.
 */
export function isSideEffectTool(toolName: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  for (const pattern of SIDE_EFFECT_TOOL_PATTERNS) {
    // Patterns that contain "|" are alternations; split and test each branch.
    if (pattern.includes("|")) {
      const branches = pattern.split("|");
      if (branches.some((b) => lower.includes(b.toLowerCase()))) return true;
    } else {
      if (lower.includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Evaluate whether a tool call should be allowed, blocked, or logged given
 * the agent's permission level.
 *
 * Behavior per level:
 * - observe     → block (adapter dispatch is already skipped upstream, but guard
 *                 defensively here too)
 * - draft       → block all side-effect tools; pass read-only tools
 * - approve     → allow, but mark as `approve_log` for audit/TODO future approval flow
 * - autonomous  → allow all
 * - empty/unknown tool name → allow by default (unknown ≠ side-effect)
 */
export function evaluateToolCall(args: EvaluateToolCallArgs): EvaluateToolCallResult {
  const { permissionLevel, toolName } = args;

  // Empty tool name — allow (unknown is not side-effect by default).
  if (!toolName) {
    return { decision: "allow", reason: "ok" };
  }

  if (permissionLevel === "observe") {
    return {
      decision: "block",
      reason: "observe_level",
      message: `Observe mode: all tool calls blocked. Tool "${toolName}" was not dispatched.`,
    };
  }

  if (permissionLevel === "autonomous") {
    return { decision: "allow", reason: "ok" };
  }

  const isSideEffect = isSideEffectTool(toolName);

  if (permissionLevel === "draft") {
    if (isSideEffect) {
      return {
        decision: "block",
        reason: "draft_side_effect",
        message: `Draft mode: side-effect tool call denied. Prepare the artifact as text output instead.`,
      };
    }
    return { decision: "allow", reason: "ok" };
  }

  if (permissionLevel === "approve") {
    if (isSideEffect) {
      // TODO(future-wave): implement async approval flow — pause execution,
      // create an approval record, wait for human decision before dispatching.
      // For v1 we allow but log as `approve_log` so activity can be audited.
      return {
        decision: "allow",
        reason: "approve_log",
        message: `Approve mode: side-effect tool "${toolName}" allowed but logged for audit.`,
      };
    }
    return { decision: "allow", reason: "ok" };
  }

  // Fallback: unknown permission level → allow.
  return { decision: "allow", reason: "ok" };
}

// ---------------------------------------------------------------------------
// Structured permission-denied result payload
//
// Returned to the LLM as a synthetic tool_result when a tool call is blocked.
// ---------------------------------------------------------------------------

export interface PermissionDeniedPayload {
  type: "permission_denied";
  level: AgentPermissionLevel;
  tool: string;
  message: string;
}

/**
 * Build the structured payload that is returned to the model when a draft-level
 * agent attempts a side-effect tool call.
 */
export function buildPermissionDeniedPayload(
  permissionLevel: AgentPermissionLevel,
  toolName: string,
): PermissionDeniedPayload {
  return {
    type: "permission_denied",
    level: permissionLevel,
    tool: toolName,
    message: `Draft mode: side-effect tool call denied. Prepare the artifact as text output instead.`,
  };
}
