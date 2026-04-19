import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={`h-full px-5 py-5 rounded-lg border border-border bg-card transition-all${
        isClickable ? " hover:border-foreground/25 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)] cursor-pointer" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground mb-3">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className="font-display text-[28px] sm:text-[34px] leading-none tabular-nums text-foreground">
        {value}
      </p>
      {description && (
        <div className="text-[12px] text-muted-foreground mt-2 leading-snug hidden sm:block">{description}</div>
      )}
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
