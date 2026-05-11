import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface QuickApproveProps {
  rowId: string;
  /** Risk class of the underlying inbox row. Only `"low"` rows are eligible. */
  risk: "high" | "medium" | "low";
  onApprove: (id: string) => void;
  onUndo: (id: string) => void;
  /** Undo window in ms. Default 10_000 per D17. */
  undoMs?: number;
}

/**
 * Inline approval affordance with optimistic commit + 10s undo window.
 * Spec: docs/design/founderos-frontend-plan/03-work-surfaces.md §A,
 * gated per D17 (risk === "low" only).
 *
 * State machine:
 *   idle  --click-->  pending  --10s timer / click Undo-->  idle
 *                       \-- timer fires --> committed (calls onApprove)
 *
 * Calling onUndo is the parent's signal to roll back the optimistic UI. The
 * commit fires exactly once at timer expiry; if the user undoes, onApprove is
 * never called.
 */
export function QuickApprove({
  rowId,
  risk,
  onApprove,
  onUndo,
  undoMs = 10_000,
}: QuickApproveProps) {
  const [state, setState] = useState<"idle" | "pending">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `committedRef` is the race-guard: once the 10s timer callback enters, it sets
  // this to `true` BEFORE calling `onApprove`. A late `handleUndo` (e.g. fired in
  // the same task tick after `advanceTimersByTime` crossed the boundary, or a
  // click landing between timer-fire and React's commit phase) sees the flag and
  // no-ops — preventing the double-dispatch where both `onApprove` and `onUndo`
  // fire for the same row. Reset on remount and when the row's risk changes.
  const committedRef = useRef(false);

  useEffect(() => {
    committedRef.current = false;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [rowId, risk]);

  // Refuse to render under non-low risk. Callers should branch to DisabledQuickApprove,
  // but guard here too so the component is misuse-safe. Placed after hooks to keep
  // hook-call order stable across renders.
  if (risk !== "low") return null;

  function handleClick() {
    if (state === "pending") return;
    committedRef.current = false;
    setState("pending");
    timerRef.current = setTimeout(() => {
      // Mark committed BEFORE invoking the callback so a same-tick handleUndo
      // observes the flag and skips its dispatch.
      committedRef.current = true;
      timerRef.current = null;
      onApprove(rowId);
      setState("idle");
    }, undoMs);
  }

  function handleUndo() {
    // Race-guard: if the timer callback already committed, refuse to fire onUndo.
    if (committedRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState("idle");
    onUndo(rowId);
  }

  if (state === "pending") {
    return (
      <button
        type="button"
        data-testid="quick-approve-undo"
        onClick={handleUndo}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-500/30",
          "bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700",
          "transition-colors hover:bg-amber-500/20 dark:text-amber-300",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        Approving · Undo
      </button>
    );
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-testid="quick-approve"
      onClick={handleClick}
      className="shrink-0"
    >
      <Check />
      Approve
    </Button>
  );
}

export interface DisabledQuickApproveProps {
  tooltip: string;
  onClick: () => void;
}

/**
 * Render for non-low-risk approval rows. Clicking opens the detail sheet
 * rather than committing — the founder must review high/medium-risk items.
 * Per D17: shipping QuickApprove on a high-risk row is the documented one-way-door.
 */
export function DisabledQuickApprove({ tooltip, onClick }: DisabledQuickApproveProps) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-testid="quick-approve-disabled"
      title={tooltip}
      aria-label={tooltip}
      onClick={onClick}
      className="shrink-0 cursor-help opacity-60"
    >
      <Check />
      Review
    </Button>
  );
}
