import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pin, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { companyMemoryApi } from "@/api/company-memory";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { CompanyMemoryEntry } from "@founderos/shared";

interface CompanyMemoryCardProps {
  companyId: string;
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface EntryRowProps {
  entry: CompanyMemoryEntry;
  onPin: (id: string) => void;
  onDelete: (id: string) => void;
}

function EntryRow({ entry, onPin, onDelete }: EntryRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "group relative px-4 py-3 transition-colors",
        entry.pinned && "bg-teal-50/40 dark:bg-teal-950/20",
      )}
    >
      {/* Entry header row */}
      <div className="flex items-start gap-2">
        {/* Pin icon */}
        <button
          aria-label={entry.pinned ? "Unpin" : "Pin"}
          onClick={() => onPin(entry.id)}
          className={cn(
            "mt-0.5 shrink-0 transition-colors",
            entry.pinned
              ? "text-teal-500 hover:text-teal-700 dark:text-teal-400"
              : "text-muted-foreground/30 hover:text-teal-500 opacity-0 group-hover:opacity-100",
          )}
        >
          <Pin className="h-3.5 w-3.5" fill={entry.pinned ? "currentColor" : "none"} />
        </button>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <button
            className="w-full text-left"
            onClick={() => setExpanded((v) => !v)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground leading-snug">
                {entry.title}
              </span>
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </div>

            {!expanded && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                {entry.body}
              </p>
            )}
          </button>

          {expanded && (
            <p className="mt-1.5 text-xs text-foreground/80 whitespace-pre-line leading-relaxed">
              {entry.body}
            </p>
          )}

          {/* Metadata row */}
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              {formatDate(entry.occurredAt)}
            </span>
            {entry.topic && (
              <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {entry.topic}
              </span>
            )}
          </div>
        </div>

        {/* Delete button */}
        <button
          aria-label="Delete"
          onClick={() => onDelete(entry.id)}
          className="mt-0.5 shrink-0 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover:opacity-100 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface AddNoteFormProps {
  onSave: (data: { title: string; body: string; topic: string }) => void;
  onCancel: () => void;
  saving: boolean;
}

function AddNoteForm({ onSave, onCancel, saving }: AddNoteFormProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [topic, setTopic] = useState("");

  return (
    <div className="px-4 py-3 border-t border-border bg-muted/30">
      <div className="space-y-2">
        <input
          type="text"
          placeholder="One-line title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <textarea
          placeholder="What did you learn or observe?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
        />
        <input
          type="text"
          placeholder="Topic (optional — e.g. growth, pricing, churn)"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={saving || !title.trim() || !body.trim()}
            onClick={() => onSave({ title: title.trim(), body: body.trim(), topic: topic.trim() })}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50 hover:opacity-80 transition-opacity"
          >
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * CompanyMemoryCard — Dashboard surface for Company Memory v1.
 *
 * Shows up to 5 most-recent entries (pinned first), a +Add note composer,
 * and pin/delete controls per entry.
 */
export function CompanyMemoryCard({ companyId }: CompanyMemoryCardProps) {
  const [composing, setComposing] = useState(false);
  const queryClient = useQueryClient();

  const { data: entries = [], isLoading } = useQuery({
    queryKey: queryKeys.companyMemory.list(companyId),
    queryFn: () => companyMemoryApi.list(companyId, { limit: 20 }),
    enabled: !!companyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.companyMemory.list(companyId) });

  const createMutation = useMutation({
    mutationFn: (data: { title: string; body: string; topic: string }) =>
      companyMemoryApi.create(companyId, {
        kind: "founder_note",
        title: data.title,
        body: data.body,
        topic: data.topic || null,
      }),
    onSuccess: () => {
      setComposing(false);
      void invalidate();
    },
  });

  const pinMutation = useMutation({
    mutationFn: (entry: CompanyMemoryEntry) =>
      companyMemoryApi.update(companyId, entry.id, { pinned: !entry.pinned }),
    onSuccess: () => void invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companyMemoryApi.remove(companyId, id),
    onSuccess: () => void invalidate(),
  });

  // Sort: pinned first, then by occurredAt desc — the API already does this
  // but we re-sort client-side to handle optimistic updates cleanly.
  const sorted = [...entries].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
  });

  const displayed = sorted.slice(0, 5);
  const pinnedEntries = displayed.filter((e) => e.pinned);
  const unpinnedEntries = displayed.filter((e) => !e.pinned);

  return (
    <section aria-label="Company Memory" className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-5 pb-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground mb-1">
          Company Memory
        </div>
        <h3 className="font-display text-xl leading-snug tracking-tight text-foreground">
          What we&apos;ve learned.
        </h3>
      </div>

      {/* Entries */}
      {isLoading ? (
        <div className="px-4 pb-4 text-sm text-muted-foreground">Loading…</div>
      ) : displayed.length === 0 && !composing ? (
        <div className="px-4 pb-4">
          <p className="text-sm text-muted-foreground">
            No memories yet. A weekly summary appears every Sunday. Or add one now.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {/* Pinned section */}
          {pinnedEntries.length > 0 && (
            <>
              {pinnedEntries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  onPin={() => pinMutation.mutate(entry)}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
              {unpinnedEntries.length > 0 && (
                <div className="h-px bg-border" />
              )}
            </>
          )}

          {/* Unpinned entries */}
          {unpinnedEntries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onPin={() => pinMutation.mutate(entry)}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </div>
      )}

      {/* Add note composer or trigger */}
      {composing ? (
        <AddNoteForm
          saving={createMutation.isPending}
          onSave={(data) => createMutation.mutate(data)}
          onCancel={() => setComposing(false)}
        />
      ) : (
        <div className="px-4 py-3 border-t border-border">
          <button
            onClick={() => setComposing(true)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            + Add note
          </button>
        </div>
      )}
    </section>
  );
}
