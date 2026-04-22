import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";

/**
 * Wave 17A — Notification preferences.
 *
 * One knob per company: daily morning digest ON/OFF, delivery hour
 * (0-23, user-local), and timezone (auto-detected from the browser).
 * Timezone is stored server-side so the cron knows when to fire
 * regardless of which device the user last touched.
 */

interface DigestPrefs {
  companyId: string;
  digestEnabled: boolean;
  digestHourLocal: number;
  digestTimezone: string;
  digestLastSentAt: string | null;
}

interface DigestPreviewResponse {
  empty: boolean;
  reason?: string;
  subject?: string;
  html?: string;
  text?: string;
  metrics?: {
    pendingDecisions: number;
    agentActions24h: number;
    failingAgents: number;
    costYesterdayCents: number;
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:00 ${suffix}`;
}

export function NotificationsSettings() {
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const browserTz = useMemo(() => detectTimezone(), []);

  const [enabled, setEnabled] = useState(true);
  const [hour, setHour] = useState(8);
  const [tz, setTz] = useState(browserTz);
  const [preview, setPreview] = useState<DigestPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const companyId = selectedCompany?.id ?? null;

  const prefsQuery = useQuery<DigestPrefs>({
    queryKey: ["digest", "prefs", companyId],
    enabled: Boolean(companyId),
    queryFn: async () =>
      api.get<DigestPrefs>(`/digest/prefs?companyId=${encodeURIComponent(companyId!)}`),
  });

  useEffect(() => {
    if (prefsQuery.data) {
      setEnabled(prefsQuery.data.digestEnabled);
      setHour(prefsQuery.data.digestHourLocal);
      setTz(prefsQuery.data.digestTimezone || browserTz);
    }
  }, [prefsQuery.data, browserTz]);

  const saveMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; hourLocal: number; timezone: string }) => {
      if (!companyId) throw new Error("No company selected");
      return api.post<DigestPrefs>("/digest/prefs", {
        companyId,
        enabled: input.enabled,
        hourLocal: input.hourLocal,
        timezone: input.timezone,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["digest", "prefs", companyId] });
    },
  });

  async function handlePreview() {
    if (!companyId) return;
    setPreviewError(null);
    try {
      const data = await api.get<DigestPreviewResponse>(
        `/digest/preview?companyId=${encodeURIComponent(companyId)}&timezone=${encodeURIComponent(tz)}`,
      );
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to load preview");
    }
  }

  if (!selectedCompany) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Notifications</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select a company to configure its morning digest.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily morning digest for <strong>{selectedCompany.name}</strong>.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-sm font-medium">Send me a morning digest</span>
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Delivery hour (local)</span>
            <select
              value={hour}
              onChange={(e) => setHour(parseInt(e.target.value, 10))}
              disabled={!enabled}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Timezone</span>
            <input
              type="text"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={!enabled}
              className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            />
            {tz !== browserTz && (
              <button
                type="button"
                onClick={() => setTz(browserTz)}
                className="self-start text-xs text-muted-foreground underline"
              >
                Use browser default: {browserTz}
              </button>
            )}
          </label>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={() =>
              saveMutation.mutate({ enabled, hourLocal: hour, timezone: tz })
            }
            disabled={saveMutation.isPending || !companyId}
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={handlePreview} disabled={!companyId}>
            Preview today's digest
          </Button>
          {saveMutation.isSuccess && (
            <span className="text-sm text-muted-foreground">Saved.</span>
          )}
        </div>

        {prefsQuery.data?.digestLastSentAt && (
          <p className="text-xs text-muted-foreground">
            Last sent: {new Date(prefsQuery.data.digestLastSentAt).toLocaleString()}
          </p>
        )}
      </div>

      {previewError && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
          {previewError}
        </div>
      )}

      {preview && (
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-base font-semibold">Preview</h2>
          {preview.empty ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {preview.reason ?? "Nothing to report today."}
            </p>
          ) : (
            <>
              <div className="mt-2 text-sm">
                <span className="text-muted-foreground">Subject:</span>{" "}
                <span className="font-medium">{preview.subject}</span>
              </div>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-xs">
                {preview.text}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
