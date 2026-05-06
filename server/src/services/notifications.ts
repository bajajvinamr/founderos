/**
 * Sprint 6 · S6.6 — notifications service.
 *
 * Per-user, per-company notifications. Used by the in-app top bar bell
 * (list, mark-read, unread count) and as the source-of-record for the
 * Slack daily summary cron.
 *
 * Tenant + user discipline: every read/write is scoped to (companyId,
 * userId) — no helper accepts a notification id alone, the caller must
 * present userId so a stolen id can't be read or marked-read by another
 * principal.
 */

import { and, desc, eq, isNull, sql, count } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { notifications } from "@founderos/db";
import type {
  NotificationKind,
  NotificationRefKind,
} from "@founderos/db";

export type NotificationRow = typeof notifications.$inferSelect;

export interface CreateNotificationParams {
  companyId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  refKind?: NotificationRefKind | null;
  refId?: string | null;
}

export function notificationsService(db: Db) {
  /**
   * Create a notification for a (company, user) pair.
   *
   * If `refKind`+`refId` are present and a notification of the same kind
   * already exists for the same ref + user that is unread, this is a
   * no-op (returns the existing row). This dedupes the "we already told
   * the user about approval=abc" case without requiring a unique index.
   */
  async function create(
    params: CreateNotificationParams,
  ): Promise<NotificationRow> {
    if ((params.refKind == null) !== (params.refId == null)) {
      throw new Error("refKind and refId must be both set or both null");
    }

    if (params.refKind && params.refId) {
      const [existing] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, params.userId),
            eq(notifications.companyId, params.companyId),
            eq(notifications.kind, params.kind),
            eq(notifications.refKind, params.refKind),
            eq(notifications.refId, params.refId),
            isNull(notifications.readAt),
          ),
        )
        .limit(1);
      if (existing) return existing;
    }

    const [row] = await db
      .insert(notifications)
      .values({
        companyId: params.companyId,
        userId: params.userId,
        kind: params.kind,
        title: params.title,
        body: params.body ?? null,
        refKind: params.refKind ?? null,
        refId: params.refId ?? null,
      })
      .returning();
    return row;
  }

  /**
   * List notifications for a (company, user) pair, newest-first.
   * Tenant + user scoped — caller must always present both ids.
   */
  async function list(
    companyId: string,
    userId: string,
    opts?: { unread?: boolean; limit?: number },
  ): Promise<NotificationRow[]> {
    const conditions = [
      eq(notifications.companyId, companyId),
      eq(notifications.userId, userId),
    ];
    if (opts?.unread === true) {
      conditions.push(isNull(notifications.readAt));
    } else if (opts?.unread === false) {
      conditions.push(sql`${notifications.readAt} IS NOT NULL`);
    }

    return db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(opts?.limit ?? 50);
  }

  /**
   * Unread count for a (company, user) pair. The bell badge query.
   * Hits the partial index `idx_notifications_user_unread`.
   */
  async function unreadCount(
    companyId: string,
    userId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, companyId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Mark a single notification as read.
   *
   * Idempotent — already-read rows are left alone (their readAt timestamp
   * is preserved). Returns true if the row exists AND belongs to the
   * caller; false otherwise. Tenant + user scoped — a stolen id from
   * another user cannot be marked.
   */
  async function markRead(
    notificationId: string,
    companyId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.companyId, companyId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });

    if (result.length > 0) return true;

    // Not updated — could be already-read (which we treat as success), or
    // not-found / wrong tenant (which we treat as failure). Disambiguate.
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.companyId, companyId),
          eq(notifications.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(existing);
  }

  /**
   * Mark every unread notification for the (company, user) pair as read.
   * Returns the count of rows affected. Used by the "mark all read"
   * dropdown action.
   */
  async function markAllRead(
    companyId: string,
    userId: string,
  ): Promise<number> {
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.companyId, companyId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return result.length;
  }

  return {
    create,
    list,
    unreadCount,
    markRead,
    markAllRead,
  };
}
