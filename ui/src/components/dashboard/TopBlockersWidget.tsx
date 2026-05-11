import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AlertCircle, ArrowRight } from "lucide-react";
import type { Agent, Approval } from "@founderos/shared";
import { approvalsApi } from "../../api/approvals";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";

/**
 * Top Blockers (BL-023 / P8.c) — surfaces work that's waiting on the founder.
 *
 * Two sources of "blocked on you":
 *  1. Pending approvals (`approvalsApi.list(companyId, "pending")`) — an agent
 *     asked for the board's sign-off and is parked until the founder decides.
 *  2. Agents whose `status === "error"` — runtime hit a wall and surfaced
 *     a human-fixable failure (missing secret, exhausted budget, bad config).
 *
 * Both surfaces already exist; this widget is the consolidated entry point so
 * a founder can scan "what's actually waiting on me?" in <5s without bouncing
 * between /approvals and /agents.
 *
 * Empty state is intentional and reassuring — "Nothing waiting on you right
 * now" is one of the magic moments the dashboard rework optimizes for.
 */

export interface BlockerItem {
  /** Unique key for React list reconciliation. */
  key: string;
  /** Where the founder lands when they click through. */
  href: string;
  /** Display label — agent or short payload title. */
  title: string;
  /** Why this is blocked — one short phrase. */
  reason: string;
  /** What category of blocker (drives the CTA verb). */
  kind: "approval" | "agent_error";
}

interface TopBlockersWidgetProps {
  companyId: string;
}

/**
 * Approval payloads carry an optional human-readable `title` field that
 * agents fill when requesting board approval. Falls back to the approval
 * type when missing (which is the v1 contract).
 */
function approvalTitle(approval: Approval): string {
  const title = (approval.payload as Record<string, unknown>)?.title;
  if (typeof title === "string" && title.trim().length > 0) return title;
  return approval.type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Pure projector — turns the (approvals, agents) tuple into the rendered
 * list. Exported so tests can exercise the projection logic without a
 * QueryClient harness.
 */
export function buildBlockerItems(
  approvals: Approval[] | undefined,
  agents: Agent[] | undefined,
): BlockerItem[] {
  const items: BlockerItem[] = [];

  // Approvals first — they're the most explicit "agent is parked waiting"
  // signal and the click-through (approve/reject) closes the loop in one
  // step.
  for (const approval of approvals ?? []) {
    if (approval.status !== "pending") continue;
    items.push({
      key: `approval:${approval.id}`,
      href: `/approvals/${approval.id}`,
      title: approvalTitle(approval),
      reason: "Needs your decision",
      kind: "approval",
    });
  }

  // Agents in error state next — these are runtime failures the founder
  // needs to acknowledge or remediate. We exclude `pending_approval` here
  // because the approval row above already represents that surface.
  for (const agent of agents ?? []) {
    if (agent.status !== "error") continue;
    items.push({
      key: `agent:${agent.id}`,
      href: `/agents/${agent.urlKey ?? agent.id}`,
      title: agent.name,
      reason: "Stuck — needs you to look",
      kind: "agent_error",
    });
  }

  return items;
}

export function TopBlockersWidget({ companyId }: TopBlockersWidgetProps) {
  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    enabled: !!companyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const items = useMemo(() => buildBlockerItems(approvals, agents), [approvals, agents]);

  return (
    <section
      aria-label="Top Blockers"
      className="rounded-md border border-border bg-card px-5 py-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Top Blockers
          </p>
        </div>
        {items.length > 0 ? (
          <Link
            to="/approvals"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            See all
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing waiting on you right now.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.slice(0, 5).map((item) => (
            <li key={item.key}>
              <Link
                to={item.href}
                className="-mx-2 flex items-center justify-between gap-3 rounded px-2 py-2.5 text-sm no-underline text-inherit hover:bg-accent/50"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {item.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.reason}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {item.kind === "approval" ? "Review" : "Unblock"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
