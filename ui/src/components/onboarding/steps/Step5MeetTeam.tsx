import { useState } from "react";
import { Pencil, Check } from "lucide-react";
import {
  AGENT_SLOTS,
  type AgentCharterMap,
  type AgentSlot,
} from "../onboarding-types.js";

interface Props {
  charters: AgentCharterMap;
  onChartersChange: (next: AgentCharterMap) => void;
}

export function Step5MeetTeam({ charters, onChartersChange }: Props) {
  const [editingSlot, setEditingSlot] = useState<AgentSlot | null>(null);

  function updateCharterText(slot: AgentSlot, next: string) {
    onChartersChange({
      ...charters,
      [slot]: { ...charters[slot], charter: next },
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Meet your team
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Four agents, briefed from your answers. Tweak any charter or accept
          all — they go live the moment you finish.
        </p>
      </div>

      <div className="space-y-3">
        {AGENT_SLOTS.map((slot) => {
          const c = charters[slot];
          const isEditing = editingSlot === slot;
          return (
            <div
              key={slot}
              className="rounded-md border border-border px-4 py-4 transition-colors hover:bg-accent/20"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-[11px] font-semibold tracking-wide">
                  {c.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {c.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {c.title}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingSlot(isEditing ? null : slot)}
                      className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={isEditing ? "Done" : "Edit charter"}
                    >
                      {isEditing ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Pencil className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>

                  {isEditing ? (
                    <textarea
                      className="mt-2 w-full min-h-[84px] rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-y"
                      value={c.charter}
                      onChange={(e) => updateCharterText(slot, e.target.value)}
                      autoFocus
                    />
                  ) : (
                    <p className="mt-2 text-sm leading-relaxed">{c.charter}</p>
                  )}

                  <div className="mt-3 rounded-md bg-muted/40 px-3 py-2">
                    <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      First priority
                    </p>
                    <p className="text-xs text-foreground/90 mt-0.5">
                      {c.firstPriority}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
