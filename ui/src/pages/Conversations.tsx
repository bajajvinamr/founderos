import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@/lib/router";
import { MessageSquare, MessageSquareText, Plus, Quote, Sparkles, ArrowLeft, BookmarkPlus } from "lucide-react";
import { conversationsApi, type Conversation, type ExtractedInsight } from "../api/conversations";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeDate(value: string | Date): string {
  return new Date(value).toLocaleString();
}

function parseParticipants(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function statusLabel(status: Conversation["extractionStatus"]): { text: string; tone: string } {
  switch (status) {
    case "pending":
      return { text: "Extracting insights…", tone: "text-muted-foreground" };
    case "complete":
      return { text: "Ready", tone: "text-emerald-600" };
    case "failed":
      return { text: "Extraction failed", tone: "text-destructive" };
  }
}

// ---------------------------------------------------------------------------
// New conversation form
// ---------------------------------------------------------------------------

function NewConversationForm({
  companyId,
  companyPrefix,
  onCancel,
}: {
  companyId: string;
  companyPrefix: string | null;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState("");
  const [transcript, setTranscript] = useState("");

  const create = useMutation({
    mutationFn: () =>
      conversationsApi.create(companyId, {
        title: title.trim(),
        transcript: transcript.trim(),
        participants: parseParticipants(participants),
        sourceKind: "transcript_paste",
      }),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(companyId) });
      pushToast({
        tone: "success",
        title: "Conversation saved",
        body: "Extracting insights now — this usually takes 15-30s.",
      });
      const base = companyPrefix ? `/${companyPrefix}` : "";
      navigate(`${base}/conversations/${conv.id}`);
    },
    onError: (err: unknown) => {
      pushToast({
        tone: "error",
        title: "Failed to save conversation",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const canSubmit =
    title.trim().length > 0 && transcript.trim().length >= 10 && !create.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        create.mutate();
      }}
      className="flex flex-col gap-4 max-w-3xl"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="conv-title" className="text-xs font-medium text-muted-foreground">
          Title
        </label>
        <Input
          id="conv-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Call with Kamal, DPS Jaipur principal"
          required
          maxLength={200}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="conv-participants" className="text-xs font-medium text-muted-foreground">
          Participants (comma-separated, optional)
        </label>
        <Input
          id="conv-participants"
          value={participants}
          onChange={(e) => setParticipants(e.target.value)}
          placeholder="Founder, Parent A, Teacher"
          maxLength={400}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="conv-transcript" className="text-xs font-medium text-muted-foreground">
          Transcript
        </label>
        <Textarea
          id="conv-transcript"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the full conversation here. Speaker labels help (e.g. 'Founder:', 'Kamal:')."
          rows={16}
          required
          minLength={10}
          className="font-mono text-[13px]"
        />
        <span className="text-[11px] text-muted-foreground">
          {transcript.length.toLocaleString()} chars · min 10
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!canSubmit}>
          <Sparkles className="h-4 w-4 mr-1" />
          {create.isPending ? "Saving…" : "Save + extract insights"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ConversationsList({
  companyId,
  companyPrefix,
  onNew,
}: {
  companyId: string;
  companyPrefix: string | null;
  onNew: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.conversations.list(companyId),
    queryFn: () => conversationsApi.list(companyId),
    // Re-poll while any row is still extracting so the founder sees status
    // flip without refreshing the page.
    refetchInterval: (query) => {
      const rows = query.state.data as Conversation[] | undefined;
      return rows?.some((r) => r.extractionStatus === "pending") ? 5_000 : false;
    },
  });

  if (isLoading) return <PageSkeleton />;
  if (error) {
    return (
      <div className="p-8 text-sm text-destructive">
        Failed to load conversations: {error instanceof Error ? error.message : "unknown error"}
      </div>
    );
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MessageSquareText}
        message="Paste a call transcript or a back-and-forth chat — we'll surface the durable lessons into your Company Memory."
        action="New conversation"
        onAction={onNew}
      />
    );
  }

  const base = companyPrefix ? `/${companyPrefix}` : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Past conversations</h2>
        <Button size="sm" onClick={onNew}>
          <Plus className="h-4 w-4 mr-1" />
          New
        </Button>
      </div>
      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Title</th>
              <th className="text-left px-3 py-2 font-medium">Participants</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Insights</th>
              <th className="text-left px-3 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = statusLabel(r.extractionStatus);
              const insightCount = r.extractedInsights?.length ?? 0;
              return (
                <tr key={r.id} className="border-t border-border hover:bg-accent/30">
                  <td className="px-3 py-2">
                    <Link
                      to={`${base}/conversations/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.participants.length > 0 ? r.participants.join(", ") : "—"}
                  </td>
                  <td className={`px-3 py-2 ${s.tone}`}>{s.text}</td>
                  <td className="px-3 py-2 tabular-nums">{insightCount}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeDate(r.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function InsightCard({
  insight,
  index,
  companyId,
  conversationId,
  onPromoted,
}: {
  insight: ExtractedInsight;
  index: number;
  companyId: string;
  conversationId: string;
  onPromoted: () => void;
}) {
  const { pushToast } = useToast();
  const promote = useMutation({
    mutationFn: () =>
      conversationsApi.promoteInsight(companyId, conversationId, { index }),
    onSuccess: () => {
      pushToast({
        tone: "success",
        title: "Promoted to memory",
        body: insight.title,
      });
      onPromoted();
    },
    onError: (err: unknown) => {
      pushToast({
        tone: "error",
        title: "Could not promote insight",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const confPct = Math.round(insight.confidence * 100);

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold">{insight.title}</h3>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            conf {confPct}%
          </span>
        </div>
        <p className="text-sm text-foreground/90">{insight.content}</p>
        <blockquote className="border-l-2 border-border pl-3 text-[13px] italic text-muted-foreground">
          <Quote className="inline h-3 w-3 mr-1 -mt-0.5" />
          {insight.source_quote}
        </blockquote>
        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={promote.isPending}
            onClick={() => promote.mutate()}
          >
            <BookmarkPlus className="h-3.5 w-3.5 mr-1" />
            {promote.isPending ? "Saving…" : "Promote to Memory"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConversationDetail({
  companyId,
  companyPrefix,
  conversationId,
}: {
  companyId: string;
  companyPrefix: string | null;
  conversationId: string;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.conversations.detail(companyId, conversationId),
    queryFn: () => conversationsApi.detail(companyId, conversationId),
    refetchInterval: (query) => {
      const conv = query.state.data as Conversation | undefined;
      return conv?.extractionStatus === "pending" ? 5_000 : false;
    },
  });

  if (isLoading) return <PageSkeleton />;
  if (error || !data) {
    return (
      <div className="p-8 text-sm text-destructive">
        Could not load conversation:{" "}
        {error instanceof Error ? error.message : "not found"}
      </div>
    );
  }

  const base = companyPrefix ? `/${companyPrefix}` : "";
  const status = statusLabel(data.extractionStatus);
  const insights = data.extractedInsights ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Link
          to={`${base}/conversations`}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
          All conversations
        </Link>
      </div>

      <div className="flex flex-col gap-1">
        <h1 className="font-display text-xl tracking-tight">{data.title}</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{formatRelativeDate(data.createdAt)}</span>
          {data.participants.length > 0 && (
            <>
              <span>·</span>
              <span>{data.participants.join(", ")}</span>
            </>
          )}
          <span>·</span>
          <span className={status.tone}>{status.text}</span>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Extracted insights</h2>
          <span className="text-xs text-muted-foreground">
            {insights.length} {insights.length === 1 ? "insight" : "insights"}
          </span>
        </div>
        {data.extractionStatus === "pending" && (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              <Sparkles className="inline h-4 w-4 mr-1 -mt-0.5" />
              Reading the transcript and pulling out durable lessons. This usually
              takes 15-30 seconds.
            </CardContent>
          </Card>
        )}
        {data.extractionStatus === "failed" && (
          <Card>
            <CardContent className="p-4 text-sm text-destructive">
              Extraction failed. Make sure an Anthropic API key is configured for
              this instance, then try again.
            </CardContent>
          </Card>
        )}
        {data.extractionStatus === "complete" && insights.length === 0 && (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              The extractor didn't find any durable lessons in this transcript.
            </CardContent>
          </Card>
        )}
        <div className="grid grid-cols-1 gap-3">
          {insights.map((insight, i) => (
            <InsightCard
              key={`${data.id}-${i}`}
              insight={insight}
              index={i}
              companyId={companyId}
              conversationId={data.id}
              onPromoted={() => refetch()}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setTranscriptOpen((v) => !v)}
          className="text-sm text-muted-foreground hover:text-foreground text-left w-fit"
        >
          {transcriptOpen ? "Hide transcript" : "Show transcript"}
        </button>
        {transcriptOpen && (
          <pre className="text-[12px] font-mono whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 max-h-[50vh] overflow-y-auto">
            {data.transcript}
          </pre>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------

export function Conversations() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { convId } = useParams<{ convId?: string; companyPrefix?: string }>();
  const [mode, setMode] = useState<"list" | "new">("list");

  useEffect(() => {
    setBreadcrumbs([{ label: "Conversations" }]);
  }, [setBreadcrumbs]);

  const companyPrefix = selectedCompany?.issuePrefix ?? null;

  if (!selectedCompanyId) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Select a company to view conversations.
      </div>
    );
  }

  if (convId) {
    return (
      <div className="p-6 max-w-4xl">
        <ConversationDetail
          companyId={selectedCompanyId}
          companyPrefix={companyPrefix}
          conversationId={convId}
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5" />
        <h1 className="font-display text-xl tracking-tight">Conversations</h1>
      </div>
      <p className="text-sm text-muted-foreground max-w-xl">
        Paste a customer call, interview, or thread. We extract the durable,
        non-obvious lessons and you promote the ones worth keeping into
        Company Memory.
      </p>

      {mode === "new" ? (
        <NewConversationForm
          companyId={selectedCompanyId}
          companyPrefix={companyPrefix}
          onCancel={() => setMode("list")}
        />
      ) : (
        <ConversationsList
          companyId={selectedCompanyId}
          companyPrefix={companyPrefix}
          onNew={() => setMode("new")}
        />
      )}
    </div>
  );
}

