/**
 * CompanyMemory — dedicated page for managing per-company memory entries
 * (audit P0.3, ships S6.4 schema/service to a real surface).
 *
 * The product story: every agent run starts blank without this. Founders need
 * a place to put facts about the company, products, customers, processes,
 * decisions — context that agents reference instead of re-asking the founder
 * on every invocation.
 *
 * Scope is deliberately CRUD-only — no embeddings, no semantic search, no
 * AI-assisted authoring. Agents already query the schema for recall via the
 * service layer; this page just gives founders a UI to feed it.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Pin, Plus, Trash2 } from "lucide-react";
import {
  memoryCategorySchema,
  type CompanyMemoryEntry,
  type MemoryCategory,
} from "@founderos/shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { companyMemoryApi } from "../api/company-memory";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "@/lib/utils";

const CATEGORY_VALUES = memoryCategorySchema.options;

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  decision: "Decision",
  pattern: "Pattern",
  context: "Context",
  outcome: "Outcome",
};

const CATEGORY_HINTS: Record<MemoryCategory, string> = {
  decision: "A choice you made and why (e.g. pricing, hiring, market focus).",
  pattern: "A repeatable observation (e.g. \"users churn when…\").",
  context: "Background facts (company, product, customers, processes).",
  outcome: "What happened after a decision or experiment.",
};

type CategoryFilter = "all" | MemoryCategory;

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface AddMemoryFormProps {
  onSubmit: (input: {
    title: string;
    body: string;
    topic: string | null;
    category: MemoryCategory | null;
  }) => void;
  onCancel: () => void;
  saving: boolean;
}

function AddMemoryForm({ onSubmit, onCancel, saving }: AddMemoryFormProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState<MemoryCategory | "">("");

  const submit = () => {
    if (!title.trim() || !body.trim()) return;
    onSubmit({
      title: title.trim(),
      body: body.trim(),
      topic: topic.trim() ? topic.trim() : null,
      category: category === "" ? null : category,
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="memory-category">
          Category
        </label>
        <Select value={category} onValueChange={(v) => setCategory(v as MemoryCategory | "")}>
          <SelectTrigger id="memory-category" className="h-9 text-sm">
            <SelectValue placeholder="Choose category (optional)" />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_VALUES.map((cat) => (
              <SelectItem key={cat} value={cat}>
                <div className="flex flex-col">
                  <span>{CATEGORY_LABELS[cat]}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {CATEGORY_HINTS[cat]}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="memory-title">
          Title
        </label>
        <input
          id="memory-title"
          type="text"
          placeholder="One-line summary"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="memory-body">
          Body
        </label>
        <textarea
          id="memory-body"
          placeholder="The fact, decision, or pattern. Agents will reference this verbatim."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          maxLength={10000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="memory-topic">
          Topic <span className="text-muted-foreground/60">(optional)</span>
        </label>
        <input
          id="memory-topic"
          type="text"
          placeholder="e.g. pricing, churn, gtm"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={100}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={saving || !title.trim() || !body.trim()}
        >
          {saving ? "Saving…" : "Save memory"}
        </Button>
      </div>
    </div>
  );
}

interface EditMemoryFormProps {
  entry: CompanyMemoryEntry;
  onSubmit: (input: { title: string; body: string; topic: string | null }) => void;
  onCancel: () => void;
  saving: boolean;
}

function EditMemoryForm({ entry, onSubmit, onCancel, saving }: EditMemoryFormProps) {
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [topic, setTopic] = useState(entry.topic ?? "");

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring font-semibold"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        maxLength={10000}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
      />
      <input
        type="text"
        placeholder="Topic (optional)"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        maxLength={100}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onSubmit({
              title: title.trim(),
              body: body.trim(),
              topic: topic.trim() ? topic.trim() : null,
            })
          }
          disabled={saving || !title.trim() || !body.trim()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface MemoryCardProps {
  entry: CompanyMemoryEntry;
  onPin: (entry: CompanyMemoryEntry) => void;
  onDelete: (entry: CompanyMemoryEntry) => void;
  onEdit: (input: { title: string; body: string; topic: string | null }) => void;
  isEditing: boolean;
  setEditing: (editing: boolean) => void;
  saving: boolean;
}

function MemoryCard({
  entry,
  onPin,
  onDelete,
  onEdit,
  isEditing,
  setEditing,
  saving,
}: MemoryCardProps) {
  if (isEditing) {
    return (
      <article className="rounded-lg border border-border bg-card p-4">
        <EditMemoryForm
          entry={entry}
          onSubmit={(input) => onEdit(input)}
          onCancel={() => setEditing(false)}
          saving={saving}
        />
      </article>
    );
  }

  return (
    <article
      data-testid="memory-card"
      className={cn(
        "group rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/80",
        entry.pinned && "border-teal-500/40 bg-teal-50/30 dark:bg-teal-950/10",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label={entry.pinned ? "Unpin" : "Pin"}
          onClick={() => onPin(entry)}
          className={cn(
            "mt-0.5 shrink-0 transition-colors",
            entry.pinned
              ? "text-teal-500 hover:text-teal-700 dark:text-teal-400"
              : "text-muted-foreground/40 hover:text-teal-500",
          )}
        >
          <Pin className="h-4 w-4" fill={entry.pinned ? "currentColor" : "none"} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {entry.category && (
              <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[entry.category]}
              </span>
            )}
            {entry.topic && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {entry.topic}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">
              {formatDate(entry.occurredAt)}
            </span>
            {entry.source === "auto" && (
              <span className="text-[10px] text-muted-foreground/70 italic">
                generated
              </span>
            )}
          </div>

          <h3 className="mt-1.5 text-sm font-semibold leading-snug text-foreground">
            {entry.title}
          </h3>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground/80">
            {entry.body}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            aria-label="Delete"
            onClick={() => onDelete(entry)}
            className="rounded-md p-1 text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
}

interface MemoryListProps {
  entries: CompanyMemoryEntry[];
  groupByCategory: boolean;
  onPin: (entry: CompanyMemoryEntry) => void;
  onDelete: (entry: CompanyMemoryEntry) => void;
  onEdit: (entry: CompanyMemoryEntry, input: { title: string; body: string; topic: string | null }) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  savingId: string | null;
}

export function MemoryList({
  entries,
  groupByCategory,
  onPin,
  onDelete,
  onEdit,
  editingId,
  setEditingId,
  savingId,
}: MemoryListProps) {
  if (!groupByCategory) {
    return (
      <div className="space-y-3">
        {entries.map((entry) => (
          <MemoryCard
            key={entry.id}
            entry={entry}
            onPin={onPin}
            onDelete={onDelete}
            onEdit={(input) => onEdit(entry, input)}
            isEditing={editingId === entry.id}
            setEditing={(editing) => setEditingId(editing ? entry.id : null)}
            saving={savingId === entry.id}
          />
        ))}
      </div>
    );
  }

  // Group: pinned first, then by category in canonical order, then uncategorized last.
  const pinned = entries.filter((e) => e.pinned);
  const unpinned = entries.filter((e) => !e.pinned);

  const byCategory = new Map<MemoryCategory | "uncategorized", CompanyMemoryEntry[]>();
  for (const entry of unpinned) {
    const key = entry.category ?? "uncategorized";
    const list = byCategory.get(key) ?? [];
    list.push(entry);
    byCategory.set(key, list);
  }

  const groupOrder: Array<MemoryCategory | "uncategorized"> = [
    ...CATEGORY_VALUES,
    "uncategorized",
  ];

  return (
    <div className="space-y-6">
      {pinned.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Pinned
          </h2>
          {pinned.map((entry) => (
            <MemoryCard
              key={entry.id}
              entry={entry}
              onPin={onPin}
              onDelete={onDelete}
              onEdit={(input) => onEdit(entry, input)}
              isEditing={editingId === entry.id}
              setEditing={(editing) => setEditingId(editing ? entry.id : null)}
              saving={savingId === entry.id}
            />
          ))}
        </section>
      )}
      {groupOrder.map((cat) => {
        const items = byCategory.get(cat);
        if (!items || items.length === 0) return null;
        const label = cat === "uncategorized" ? "Uncategorized" : CATEGORY_LABELS[cat];
        return (
          <section key={cat} className="space-y-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {label}
            </h2>
            {items.map((entry) => (
              <MemoryCard
                key={entry.id}
                entry={entry}
                onPin={onPin}
                onDelete={onDelete}
                onEdit={(input) => onEdit(entry, input)}
                isEditing={editingId === entry.id}
                setEditing={(editing) => setEditingId(editing ? entry.id : null)}
                saving={savingId === entry.id}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function CompanyMemory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const { data: entries = [], isLoading, error } = useQuery({
    queryKey: queryKeys.companyMemory.list(selectedCompanyId!),
    queryFn: () => companyMemoryApi.list(selectedCompanyId!, { limit: 200 }),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.companyMemory.list(selectedCompanyId!),
    });

  const createMutation = useMutation({
    mutationFn: (input: {
      title: string;
      body: string;
      topic: string | null;
      category: MemoryCategory | null;
    }) =>
      companyMemoryApi.create(selectedCompanyId!, {
        kind: "founder_note",
        title: input.title,
        body: input.body,
        topic: input.topic,
        category: input.category,
      }),
    onSuccess: () => {
      setComposing(false);
      void invalidate();
    },
  });

  const pinMutation = useMutation({
    mutationFn: (entry: CompanyMemoryEntry) =>
      companyMemoryApi.update(selectedCompanyId!, entry.id, { pinned: !entry.pinned }),
    onSuccess: () => void invalidate(),
  });

  const updateMutation = useMutation({
    mutationFn: (args: {
      entry: CompanyMemoryEntry;
      input: { title: string; body: string; topic: string | null };
    }) => {
      setSavingId(args.entry.id);
      return companyMemoryApi.update(selectedCompanyId!, args.entry.id, args.input);
    },
    onSuccess: () => {
      setEditingId(null);
      setSavingId(null);
      void invalidate();
    },
    onError: () => {
      setSavingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: CompanyMemoryEntry) =>
      companyMemoryApi.remove(selectedCompanyId!, entry.id),
    onSuccess: () => void invalidate(),
  });

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.category === filter);
  }, [entries, filter]);

  // Sort: pinned first, then occurredAt desc — server already sorts but
  // optimistic updates can land anywhere in the cache.
  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      }),
    [filtered],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to view memory." />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-foreground">Company Memory</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Context your agents reference. Add facts about your company, products, customers,
            and processes — every agent run reads these instead of starting blank.
          </p>
        </div>
        {!composing && (
          <Button onClick={() => setComposing(true)} className="gap-1.5 self-start sm:self-end">
            <Plus className="h-4 w-4" />
            Add memory
          </Button>
        )}
      </header>

      {composing && (
        <AddMemoryForm
          saving={createMutation.isPending}
          onCancel={() => setComposing(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      )}

      {entries.length > 5 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter:</span>
          <Select value={filter} onValueChange={(v) => setFilter(v as CategoryFilter)}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORY_VALUES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {CATEGORY_LABELS[cat]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load memory."}
        </p>
      )}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Brain}
          message="No memory entries yet. Add your first one to give your agents context."
          action={composing ? undefined : "Add memory"}
          onAction={() => setComposing(true)}
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Brain}
          message="No entries match this filter."
        />
      ) : (
        <MemoryList
          entries={sorted}
          groupByCategory={entries.length > 5 && filter === "all"}
          onPin={(entry) => pinMutation.mutate(entry)}
          onDelete={(entry) => {
            if (window.confirm(`Delete memory \"${entry.title}\"?`)) {
              deleteMutation.mutate(entry);
            }
          }}
          onEdit={(entry, input) => updateMutation.mutate({ entry, input })}
          editingId={editingId}
          setEditingId={setEditingId}
          savingId={savingId}
        />
      )}
    </div>
  );
}
