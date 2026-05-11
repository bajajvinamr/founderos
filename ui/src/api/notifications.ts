/**
 * Audit P0.2 — notifications API client.
 *
 * Wraps the four S6.6 server endpoints exposed by
 * `server/src/routes/notifications.ts`. Polling-only for V1; the audit
 * accepted polling and explicitly defers WS push.
 */

import { api } from "./client";

/**
 * Notification row shape returned by the server. Mirrored from
 * `notifications.$inferSelect` (see `packages/db/src/schema/notifications.ts`)
 * — the UI doesn't import from `@founderos/db` directly. Server returns
 * timestamps as ISO strings via the JSON serializer.
 */
export type NotificationKind =
  | "approval_needed"
  | "insight_critical"
  | "workflow_completed"
  | "integration_failed";

export type NotificationRefKind =
  | "approval"
  | "insight"
  | "workflow_run"
  | "integration";

export interface NotificationRow {
  id: string;
  companyId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  refKind: NotificationRefKind | null;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
}

export const notificationsApi = {
  list: (companyId: string, opts?: { unread?: boolean; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.unread !== undefined) params.set("unread", String(opts.unread));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<{ notifications: NotificationRow[] }>(
      `/companies/${companyId}/notifications${qs ? `?${qs}` : ""}`,
    );
  },
  unreadCount: (companyId: string) =>
    api.get<{ unreadCount: number }>(
      `/companies/${companyId}/notifications/unread-count`,
    ),
  markRead: (companyId: string, notificationId: string) =>
    api.post<{ ok: true }>(
      `/companies/${companyId}/notifications/${notificationId}/read`,
      {},
    ),
  markAllRead: (companyId: string) =>
    api.post<{ updatedCount: number }>(
      `/companies/${companyId}/notifications/read-all`,
      {},
    ),
};
