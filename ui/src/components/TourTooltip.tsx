import { useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronLeft, X } from "lucide-react";

interface TourTooltipProps {
  targetSelector: string;
  title: string;
  body: string;
  step: number;
  total: number;
  onNext: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TourTooltip({
  targetSelector,
  title,
  body,
  step,
  total,
  onNext,
  onSkip,
  onBack,
}: TourTooltipProps) {
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      const target = document.querySelector(targetSelector) as HTMLElement;
      if (!target) {
        setTooltipPos(null);
        setTargetRect(null);
        return;
      }

      const rect = target.getBoundingClientRect();
      const scrollTop = window.scrollY;
      const scrollLeft = window.scrollX;

      // Position tooltip below the target
      let top = rect.bottom + scrollTop + 16;
      let left = rect.left + scrollLeft + rect.width / 2 - 160; // tooltip ~320px wide, center it

      // Keep tooltip in view horizontally
      if (left < 16) left = 16;
      if (left + 320 > window.innerWidth - 16) left = window.innerWidth - 320 - 16;

      setTooltipPos({ top, left });
      setTargetRect({
        top: rect.top + scrollTop,
        left: rect.left + scrollLeft,
        width: rect.width,
        height: rect.height,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition);
    };
  }, [targetSelector]);

  if (!tooltipPos || !targetRect) {
    return null;
  }

  return (
    <>
      {/* Overlay with spotlight */}
      <div
        ref={overlayRef}
        className="fixed inset-0 z-40 pointer-events-none"
        style={{
          background: "rgba(0, 0, 0, 0.5)",
          WebkitMaskImage: `radial-gradient(circle 150px at ${targetRect.left + targetRect.width / 2}px ${targetRect.top + targetRect.height / 2}px, transparent 0%, black 100%)`,
          maskImage: `radial-gradient(circle 150px at ${targetRect.left + targetRect.width / 2}px ${targetRect.top + targetRect.height / 2}px, transparent 0%, black 100%)`,
        }}
      />

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="fixed z-50 max-w-xs rounded-lg border border-border bg-card shadow-lg p-4 pointer-events-auto"
        style={{
          top: `${tooltipPos.top}px`,
          left: `${tooltipPos.left}px`,
          animation: "fadeIn 150ms ease-out",
        }}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button
            onClick={onSkip}
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Skip tour"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-foreground/70 mb-4">{body}</p>

        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {step} of {total}
          </div>
          <div className="flex items-center gap-2">
            {onBack && step > 1 && (
              <button
                onClick={onBack}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded hover:bg-accent/50 transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Back
              </button>
            )}
            <button
              onClick={onNext}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-foreground text-background rounded hover:bg-foreground/90 transition-colors"
            >
              {step === total ? "Done" : "Next"}
              {step < total && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        <style>{`
          @keyframes fadeIn {
            from {
              opacity: 0;
              transform: translateY(-8px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}</style>
      </div>
    </>
  );
}
