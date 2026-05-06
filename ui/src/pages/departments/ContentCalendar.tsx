import { useCallback, useState, useMemo } from "react";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar as CalendarIcon, Clock, MoreVertical } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { formatDate } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface ContentDraft {
  id: string;
  companyId: string;
  briefId: string;
  format: "linkedin" | "x-thread" | "newsletter" | "reel" | "landing" | "ad";
  status: "drafted" | "edited" | "approved" | "published" | "discarded";
  payload: Record<string, unknown>;
  scheduledFor?: Date | string | null;
  publishedAt?: Date | string | null;
  publishedToUrl?: string | null;
  error?: string | null;
}

interface ContentCalendarProps {
  drafts: ContentDraft[];
  onDraftSelect?: (draft: ContentDraft) => void;
  isLoading?: boolean;
}

type ViewMode = "week" | "month";

const DAYS_OF_WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── Component ────────────────────────────────────────────────────────────────

export function ContentCalendar({
  drafts,
  onDraftSelect,
  isLoading = false,
}: ContentCalendarProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [rescheduleDialog, setRescheduleDialog] = useState<{
    draft: ContentDraft;
    newDate: Date;
  } | null>(null);

  // Filter drafts that have scheduledFor set and status is 'approved'
  const scheduledDrafts = useMemo(
    () => drafts.filter((d) => d.scheduledFor && d.status === "approved"),
    [drafts]
  );

  // Group drafts by date for week view
  const draftsByDate = useMemo(() => {
    const grouped = new Map<string, ContentDraft[]>();
    scheduledDrafts.forEach((draft) => {
      if (draft.scheduledFor) {
        const d = new Date(draft.scheduledFor);
        const dateStr = d.toISOString().split("T")[0];
        if (!grouped.has(dateStr)) {
          grouped.set(dateStr, []);
        }
        grouped.get(dateStr)!.push(draft);
      }
    });
    // Sort each day's drafts by time
    grouped.forEach((items) => {
      items.sort((a, b) => {
        if (!a.scheduledFor || !b.scheduledFor) return 0;
        return new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime();
      });
    });
    return grouped;
  }, [scheduledDrafts]);

  const handleReschedule = useCallback(
    async (draft: ContentDraft, newDateTime: Date) => {
      try {
        const response = await fetch(
          `/api/content-drafts/${draft.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledFor: newDateTime.toISOString() }),
          }
        );
        if (!response.ok) {
          const error = await response.json();
          pushToast({
            title: "Error",
            body: error.error || "Failed to reschedule draft",
            tone: "error",
          });
          return;
        }
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const timeStr = newDateTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        pushToast({
          title: "Draft rescheduled",
          body: `Scheduled for ${monthNames[newDateTime.getMonth()]} ${newDateTime.getDate()}, ${timeStr}`,
          tone: "success",
        });
        setRescheduleDialog(null);
      } catch (err) {
        pushToast({
          title: "Error",
          body: err instanceof Error ? err.message : "Failed to reschedule",
          tone: "error",
        });
      }
    },
    [pushToast]
  );

  if (isLoading) {
    return <div className="p-6 text-center text-sm text-gray-500">Loading calendar...</div>;
  }

  if (scheduledDrafts.length === 0) {
    return (
      <EmptyState
        icon={CalendarIcon}
        message="No scheduled drafts"
      />
    );
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
        <TabsList>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="month">Month</TabsTrigger>
        </TabsList>

        <TabsContent value="week" className="space-y-4">
          <WeekView draftsByDate={draftsByDate} onReschedule={setRescheduleDialog} />
        </TabsContent>

        <TabsContent value="month" className="space-y-4">
          <MonthView scheduledDrafts={scheduledDrafts} onReschedule={setRescheduleDialog} />
        </TabsContent>
      </Tabs>

      {rescheduleDialog && (
        <RescheduleDialog
          draft={rescheduleDialog.draft}
          onConfirm={(newDate) => handleReschedule(rescheduleDialog.draft, newDate)}
          onCancel={() => setRescheduleDialog(null)}
        />
      )}
    </div>
  );
}

// ── Week View ────────────────────────────────────────────────────────────────

interface WeekViewProps {
  draftsByDate: Map<string, ContentDraft[]>;
  onReschedule: (state: { draft: ContentDraft; newDate: Date } | null) => void;
}

function WeekView({ draftsByDate, onReschedule }: WeekViewProps) {
  const today = new Date();
  // Get Monday of this week
  const dayOfWeek = today.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - daysFromMonday);

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="grid grid-cols-7 gap-0 bg-gray-50 border-b">
        {weekDays.map((day) => (
          <div key={day.toISOString()} className="p-3 text-center border-r last:border-r-0">
            <div className="text-xs font-medium text-gray-600">{DAYS_OF_WEEK[day.getDay() === 0 ? 6 : day.getDay() - 1]}</div>
            <div className="text-sm font-semibold text-gray-900">{day.getDate()}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0">
        {weekDays.map((day) => {
          const dateStr = day.toISOString().split("T")[0];
          const draftsOnDay = draftsByDate.get(dateStr) || [];
          return (
            <div
              key={dateStr}
              className="border-r last:border-r-0 p-3 min-h-[300px] bg-white space-y-2 text-xs"
            >
              {draftsOnDay.map((draft) => (
                <DraftCell key={draft.id} draft={draft} onReschedule={onReschedule} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Month View ───────────────────────────────────────────────────────────────

interface MonthViewProps {
  scheduledDrafts: ContentDraft[];
  onReschedule: (state: { draft: ContentDraft; newDate: Date } | null) => void;
}

function MonthView({ scheduledDrafts, onReschedule }: MonthViewProps) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  // Generate all days in month
  const days: Date[] = [];
  const d = new Date(monthStart);
  while (d <= monthEnd) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }

  // Pad start of month
  const startDay = monthStart.getDay();
  const paddedDays: (Date | null)[] = [
    ...Array(startDay).fill(null),
    ...days,
  ];

  const draftsByDate = new Map<string, ContentDraft[]>();
  scheduledDrafts.forEach((draft) => {
    if (draft.scheduledFor) {
      const dateStr = new Date(draft.scheduledFor).toISOString().split("T")[0];
      if (!draftsByDate.has(dateStr)) {
        draftsByDate.set(dateStr, []);
      }
      draftsByDate.get(dateStr)!.push(draft);
    }
  });

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="grid grid-cols-7 gap-0 bg-gray-50 border-b">
        {DAYS_OF_WEEK.map((day) => (
          <div key={day} className="p-2 text-center text-xs font-medium text-gray-600">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0">
        {paddedDays.map((day, idx) => {
          if (!day) {
            return <div key={`empty-${idx}`} className="p-2 bg-gray-50 border-r border-b" />;
          }

          const dateStr = day.toISOString().split("T")[0];
          const draftsOnDay = draftsByDate.get(dateStr) || [];

          return (
            <div
              key={dateStr}
              className="border-r border-b p-2 min-h-[120px] bg-white space-y-1 hover:bg-blue-50 transition-colors"
            >
              <div className="text-sm font-semibold text-gray-900">{day.getDate()}</div>
              {draftsOnDay.length > 0 && (
                <>
                  <div className="text-xs text-gray-500">{draftsOnDay.length} item(s)</div>
                  <div className="space-y-1">
                    {draftsOnDay.slice(0, 2).map((draft) => (
                      <div
                        key={draft.id}
                        className="text-xs bg-blue-100 text-blue-900 px-2 py-1 rounded truncate"
                        title={getFormatLabel(draft.format)}
                      >
                        {getFormatLabel(draft.format)}
                      </div>
                    ))}
                  </div>
                  {draftsOnDay.length > 2 && (
                    <div className="text-xs text-gray-500">+{draftsOnDay.length - 2} more</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Draft Cell ───────────────────────────────────────────────────────────────

interface DraftCellProps {
  draft: ContentDraft;
  onReschedule: (state: { draft: ContentDraft; newDate: Date } | null) => void;
}

function DraftCell({ draft, onReschedule }: DraftCellProps) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div
      className="bg-blue-50 border border-blue-200 rounded p-2 hover:shadow-sm transition-shadow group"
      onMouseLeave={() => setShowMenu(false)}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 truncate text-xs">
            {getFormatLabel(draft.format)}
          </div>
          {draft.scheduledFor && (
            <div className="text-xs text-gray-600 flex items-center gap-1 mt-1">
              <Clock className="w-3 h-3" />
              {new Date(draft.scheduledFor).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-blue-200 rounded"
        >
          <MoreVertical className="w-3 h-3" />
        </button>
      </div>
      {showMenu && (
        <button
          onClick={() => {
            onReschedule({
              draft,
              newDate: draft.scheduledFor ? new Date(draft.scheduledFor) : new Date()
            });
            setShowMenu(false);
          }}
          className="w-full mt-2 text-left text-xs px-2 py-1 hover:bg-blue-200 rounded text-gray-900"
        >
          Reschedule
        </button>
      )}
    </div>
  );
}

// ── Reschedule Dialog ────────────────────────────────────────────────────────

interface RescheduleDialogProps {
  draft: ContentDraft;
  onConfirm: (newDate: Date) => void;
  onCancel: () => void;
}

function RescheduleDialog({ draft, onConfirm, onCancel }: RescheduleDialogProps) {
  const getDateString = (date: Date | string): string => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const getTimeString = (date: Date | string): string => {
    const d = new Date(date);
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  const [newDate, setNewDate] = useState(
    draft.scheduledFor ? getDateString(draft.scheduledFor) : getDateString(new Date())
  );
  const [newTime, setNewTime] = useState(
    draft.scheduledFor ? getTimeString(draft.scheduledFor) : "09:00"
  );

  const handleConfirm = () => {
    const combinedDateTime = new Date(`${newDate}T${newTime}:00`);
    onConfirm(combinedDateTime);
  };

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule Draft</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Time</label>
            <input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Reschedule</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getFormatLabel(format: string): string {
  const labels: Record<string, string> = {
    linkedin: "LinkedIn",
    "x-thread": "X Thread",
    newsletter: "Newsletter",
    reel: "Reel",
    landing: "Landing",
    ad: "Ad",
  };
  return labels[format] || format;
}
