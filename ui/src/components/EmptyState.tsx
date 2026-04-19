import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, message, action, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border mb-5">
        <Icon className="h-5 w-5 text-muted-foreground/70" />
      </div>
      <p className="font-display text-[22px] leading-[1.2] tracking-tight text-foreground max-w-sm mb-6">
        {message}
      </p>
      {action && onAction && (
        <Button onClick={onAction} variant="outline" className="gap-1.5">
          <Plus className="h-4 w-4" />
          {action}
        </Button>
      )}
    </div>
  );
}
