import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { MessageSquareHeart } from "lucide-react";
import { decisionOutcomesApi } from "../api/decision-outcomes";
import { queryKeys } from "../lib/queryKeys";

interface PendingOutcomesBannerProps {
  companyId: string;
}

/**
 * Dashboard banner shown when >=1 approved decisions from 2 weeks ago are
 * waiting for the founder to answer "what happened?".
 *
 * Click-through goes to /approvals so the founder can work through the list.
 * Renders nothing when count === 0, so it's safe to drop unconditionally on
 * the dashboard.
 */
export function PendingOutcomesBanner({ companyId }: PendingOutcomesBannerProps) {
  const { data } = useQuery({
    queryKey: queryKeys.decisionOutcomes.pending(companyId),
    queryFn: () => decisionOutcomesApi.listPending(companyId),
    enabled: !!companyId,
  });

  const count = data?.count ?? 0;
  if (count === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-sky-300 bg-sky-50 px-4 py-3 dark:border-sky-500/25 dark:bg-sky-950/60">
      <div className="flex items-center gap-2.5">
        <MessageSquareHeart className="h-4 w-4 text-sky-600 dark:text-sky-400 shrink-0" />
        <p className="text-sm text-sky-900 dark:text-sky-100">
          <span className="font-medium">
            {count} decision{count === 1 ? "" : "s"} from 2 weeks ago need outcome{count === 1 ? "" : "s"}
          </span>
          <span className="text-sky-800/80 dark:text-sky-200/80"> — {count < 3 ? "1" : "2"} min to answer</span>
        </p>
      </div>
      <Link
        to="/approvals?status=approved"
        className="text-sm font-medium text-sky-700 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100 underline underline-offset-2 shrink-0"
      >
        Close the loop
      </Link>
    </div>
  );
}
