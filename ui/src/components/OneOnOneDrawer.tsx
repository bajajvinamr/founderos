import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, X } from "lucide-react";
import { agentsApi } from "../api/agents";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIconPicker";
import { cn } from "../lib/utils";
import type { Agent } from "@founderos/shared";

// ──────────────────────────────────────────────
// Parser helper (exported for tests)
// ──────────────────────────────────────────────

export interface FounderNote {
  added: Date;
  body: string;
}

export function parseFounderNotes(promptTemplate: string): FounderNote[] {
  if (!promptTemplate) return [];
  try {
    const re = /<founder_note\s+added="([^"]+)"\s*>([\s\S]*?)<\/founder_note>/g;
    const results: FounderNote[] = [];
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop pattern
    while ((match = re.exec(promptTemplate)) !== null) {
      const added = new Date(match[1] ?? "");
      const body = (match[2] ?? "").trim();
      if (!Number.isNaN(added.getTime()) && body.length > 0) {
        results.push({ added, body });
      }
    }
    // Newest first
    results.sort((a, b) => b.added.getTime() - a.added.getTime());
    return results;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// Next-shift helper
// ──────────────────────────────────────────────

function formatNextShift(agent: Agent): string {
  if (!agent.lastHeartbeatAt) return "on their schedule";
  const runtimeConfig = agent.runtimeConfig as Record<string, unknown>;
  const intervalMinutes =
    typeof runtimeConfig.heartbeatIntervalMinutes === "number"
      ? runtimeConfig.heartbeatIntervalMinutes
      : 60;
  const lastMs = new Date(agent.lastHeartbeatAt).getTime();
  const nextMs = lastMs + intervalMinutes * 60 * 1000;
  const diffMs = nextMs - Date.now();
  if (diffMs <= 0) return "soon";
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `in ~${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  return `in ~${diffH}h`;
}

function formatNoteDate(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ──────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────

interface OneOnOneDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  companyId: string;
  /** The agent's setup tab URL, e.g. /agents/{ref}/configuration */
  setupHref: string;
}

export function OneOnOneDrawer({ open, onOpenChange, agent, companyId, setupHref }: OneOnOneDrawerProps) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [note, setNote] = useState("");
  const MAX_CHARS = 2000;

  // Parse existing founder notes from promptTemplate
  const promptTemplate =
    typeof (agent.adapterConfig as Record<string, unknown>).promptTemplate === "string"
      ? (agent.adapterConfig as Record<string, unknown>).promptTemplate as string
      : "";
  const existingNotes = parseFounderNotes(promptTemplate);

  const appendNote = useMutation({
    mutationFn: ({ note }: { note: string }) =>
      agentsApi.appendFounderNote(companyId, agent.id, note),
    onSuccess: () => {
      pushToast({
        title: `Note sent to ${agent.name}. Takes effect next shift.`,
        tone: "success",
      });
      setNote("");
      // Invalidate agent query so the updated promptTemplate is reflected
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: () => {
      pushToast({ title: "Failed to send note. Please try again.", tone: "error" });
    },
  });

  const handleSubmit = useCallback(() => {
    const trimmed = note.trim();
    if (!trimmed || appendNote.isPending) return;
    appendNote.mutate({ note: trimmed });
  }, [note, appendNote]);

  // Auto-grow textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length > MAX_CHARS) return;
    setNote(value);
    // Auto-grow
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Focus textarea on open
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open]);

  const handleComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const nextShift = formatNextShift(agent);
  const charLeft = MAX_CHARS - note.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[420px] max-w-full p-0 flex flex-col"
      >
        {/* ── Header ── */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/60 flex-row items-center gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="shrink-0 flex items-center justify-center h-10 w-10 rounded-lg bg-accent">
              <AgentIcon icon={agent.icon} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-[Instrument_Serif,_serif] text-lg font-semibold truncate leading-tight">
                {agent.name}
              </h2>
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground capitalize mt-0.5">
                {agent.role}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onOpenChange(false)}
            className="shrink-0"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </SheetHeader>

        {/* ── Notes list ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {existingNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center gap-2">
              <MessageCircle className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No notes yet.</p>
              <p className="text-xs text-muted-foreground/60">This is your direct line.</p>
            </div>
          ) : (
            existingNotes.map((n, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: notes don't have stable IDs
                key={i}
                className="bg-muted/40 border border-border/60 rounded-2xl px-4 py-3 space-y-1"
              >
                <p className="font-mono text-[10px] text-muted-foreground">
                  {formatNoteDate(n.added)}
                </p>
                <p className="text-sm whitespace-pre-wrap break-words">{n.body}</p>
              </div>
            ))
          )}
        </div>

        {/* ── Composer ── */}
        <div className="border-t border-border/60 px-5 py-4 space-y-3 shrink-0">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={note}
              onChange={handleTextareaChange}
              onKeyDown={handleComposerKeyDown}
              placeholder={`Type what you want ${agent.name} to know. Takes effect next shift.`}
              rows={3}
              style={{ minHeight: "72px", maxHeight: "192px", resize: "none" }}
              className={cn(
                "w-full rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-sm",
                "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-teal-500/40",
                "transition-colors overflow-y-auto",
              )}
            />
          </div>
          <div className="flex items-center justify-between">
            <span
              className={cn(
                "font-mono text-[10px]",
                charLeft < 100 ? "text-orange-500" : "text-muted-foreground/50",
              )}
            >
              {note.length}/{MAX_CHARS}
            </span>
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700 text-white"
              onClick={handleSubmit}
              disabled={!note.trim() || appendNote.isPending}
            >
              {appendNote.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>

        {/* ── Footer meta ── */}
        <div className="border-t border-border/60 px-5 py-3 flex items-center justify-between shrink-0">
          <p className="font-mono text-[10px] text-muted-foreground">
            {agent.name}&apos;s next shift: {nextShift}
          </p>
          <a
            href={setupHref}
            className="font-mono text-[10px] text-teal-600 hover:underline"
          >
            Open Setup →
          </a>
        </div>
      </SheetContent>
    </Sheet>
  );
}
