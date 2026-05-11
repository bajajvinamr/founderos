import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface UndoToastProps {
  /** Human-readable toast message, e.g. "Archived 3 items." */
  message: string;
  /** Called when the user clicks Undo before the timer expires. */
  onUndo: () => void;
  /** Called when the toast auto-dismisses without an undo. Optional. */
  onDismiss?: () => void;
  /** Auto-dismiss window in ms. Default 10_000 per spec. */
  durationMs?: number;
}

/**
 * Slide-in undo toast.
 * Spec: docs/design/founderos-frontend-plan/03-work-surfaces.md §A;
 * motion: 05-design-system.md §3 (200ms slide-in from bottom, ease-out).
 *
 * Shows {message} + Undo button + 10s countdown progress bar. Dismisses on
 * Undo click (fires onUndo) or after durationMs (fires onDismiss).
 *
 * Renders nothing after dismissal — parents should re-mount the component
 * keyed by a fresh id to show another toast.
 */
export function UndoToast({
  message,
  onUndo,
  onDismiss,
  durationMs = 10_000,
}: UndoToastProps) {
  const [visible, setVisible] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  const rafRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    startRef.current = Date.now();

    function tick() {
      const next = Math.min(durationMs, Date.now() - startRef.current);
      setElapsed(next);
      if (next < durationMs) {
        rafRef.current =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(tick)
            : null;
      }
    }
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(tick);
    }

    dismissTimerRef.current = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);

    return () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafRef.current);
      }
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
    // Lifecycle is bound to mount/unmount only; callbacks read latest via closure-refresh
    // would require refs — but the spec says the toast is single-shot, so re-mount is
    // the supported re-entry path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  const remaining = Math.max(0, durationMs - elapsed);
  const progressPct = Math.max(0, Math.min(100, (remaining / durationMs) * 100));

  function handleUndo() {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setVisible(false);
    onUndo();
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2",
        "flex flex-col gap-1 rounded-lg border border-border/70 bg-card px-4 py-2.5 shadow-lg",
        "min-w-[280px] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200 motion-safe:ease-out",
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-foreground">{message}</span>
        <button
          type="button"
          onClick={handleUndo}
          data-testid="undo-toast-undo"
          className={cn(
            "text-xs font-medium text-primary hover:underline",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm px-1",
          )}
        >
          Undo →
        </button>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <div
          data-testid="undo-toast-progress"
          className="h-full bg-primary/60 transition-[width] duration-150 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}
