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
   * no-op (returns the existing row). The dedup key is
   * (companyId, userId, kind, refKind, refId) and is backed by the
   * partial unique index `uniq_notifications_unread_dedup` (migration
   * 0103) which enforces atomicity under concurrent writes — closing
   * the SELECT-then-INSERT TOCTOU window the prior implementation had.
   *
   * Marked-read race handling: if the conflicting unread row is
   * marked-read between our INSERT failure and the re-SELECT, we retry
   * the insert once (bounded). The retry will succeed because the
   * partial unique no longer carries the now-read row. After two
   * attempts we give up and throw — not silently retry forever.
   */
  async function create(
    params: CreateNotificationParams,
  ): Promise<NotificationRow> {
    if ((params.refKind == null) !== (params.refId == null)) {
      throw new Error("refKind and refId must be both set or both null");
    }

    const insertValues = {
      companyId: params.companyId,
      userId: params.userId,
      kind: params.kind,
      title: params.title,
      body: params.body ?? null,
      refKind: params.refKind ?? null,
      refId: params.refId ?? null,
    };

    // Bounded retry loop. The marked-read race (PR-3 council R1+R2 P2)
    // resolves on the second insert because the read row no longer sits
    // in the partial unique. Two attempts is sufficient — a third would
    // signal a different bug (e.g. constant high-rate creates against
    // the same key, which the caller should be deduping upstream).
    for (let attempt = 0; attempt < 2; attempt++) {
      const [inserted] = await db
        .insert(notifications)
        .values(insertValues)
        // Explicit `target` + `where` (NOT bare onConflictDoNothing) so
        // that ONLY the partial unique `uniq_notifications_unread_dedup`
        // is treated as a no-op; future unique constraints would still
        // throw. PR-3 council R2 P3 fix.
        .onConflictDoNothing({
          target: [
            notifications.companyId,
            notifications.userId,
            notifications.kind,
            notifications.refKind,
            notifications.refId,
          ],
          where: sql`${notifications.readAt} IS NULL AND ${notifications.refKind} IS NOT NULL AND ${notifications.refId} IS NOT NULL`,
        })
        .returning();
      if (inserted) return inserted;

      // Conflict path — only reachable when (refKind, refId) are both
      // set per the partial unique's WHERE. Re-SELECT the existing
      // unread row, scoped to (companyId, userId, kind, ref) — same
      // tuple as the unique index so we can't cross-tenant leak.
      if (!params.refKind || !params.refId) {
        // Defensive: schema invariant violated — partial unique only
        // fires when ref is set, so a conflict on a ref-less insert
        // means the index shape diverged from the code.
        throw new Error(
          "notifications.create: ON CONFLICT fired without ref — schema invariant violated",
        );
      }
      const [existing] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.companyId, params.companyId),
            eq(notifications.userId, params.userId),
            eq(notifications.kind, params.kind),
            eq(notifications.refKind, params.refKind),
            eq(notifications.refId, params.refId),
            isNull(notifications.readAt),
          ),
        )
        .limit(1);
      if (existing) return existing;
      // Existing row vanished (marked-read between INSERT and SELECT).
      // Loop back and retry the insert — the partial unique no longer
      // carries the read row, so the second attempt should succeed.
    }

    throw new Error(
      "notifications.create: dedup conflict persisted across 2 retries — high-rate concurrent creates against same dedup key, caller should batch upstream",
    );
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
