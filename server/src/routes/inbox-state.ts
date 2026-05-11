/**
 * P3 Wave 2 · W2.5 — Inbox state routes.
 *
 * Per-user, polymorphic Inbox state for approvals/issues/decisions/
 * mentions. Drives the Inbox UI's read/unread, snooze, archive, and
 * QuickApprove 10s-undo flow.
 *
 * RBAC:
 *   - Every endpoint requires board auth + a resolved userId (the
 *     row owner). userId comes from `req.actor.userId` exclusively —
 *     never from the body or query string, per the task brief.
 *   - There is no companyId on inbox_state. Cross-user isolation is
 *     enforced by the user_id column + the per-call scope in the
 *     handlers; cross-tenant isolation lives on the underlying
 *     entity tables (an attacker can't fabricate a snooze row for an
 *     approval they can't see, because the UI only shows entities
 *     they can access).
 *
 * Routes:
 *   POST /api/inbox-state/snooze         — snooze until { snoozed_until }
 *   POST /api/inbox-state/archive        — archive
 *   POST /api/inbox-state/mark-read      — mark read
 *   POST /api/inbox-state/undo-archive   — undo archive (10s QuickApprove pattern)
 *   GET  /api/inbox-state/me?state=...   — list current user's rows
 *
 * Upsert semantics: snooze/archive/mark-read/undo-archive are all
 * idempotent — repeated calls on the same (user, entity_type,
 * entity_id) update the existing row instead of creating duplicates.
 * Backstopped by the UNIQUE(user_id, entity_type, entity_id) index.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@founderos/db";
import {
  inboxState,
  INBOX_STATE_ENTITY_TYPES,
  INBOX_STATES,
  type InboxState,
} from "@founderos/db";
import { assertBoard } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";

const entityTypeSchema = z.enum(INBOX_STATE_ENTITY_TYPES);
const stateSchema = z.enum(INBOX_STATES);

const entityRefSchema = z.object({
  entity_type: entityTypeSchema,
  entity_id: z.string().uuid(),
});

const snoozeBodySchema = entityRefSchema.extend({
  // ISO-8601 datetime; future timestamps only (validated downstream).
  snoozed_until: z.string().datetime({ offset: true }),
});

const meQuerySchema = z.object({
  state: z.string().optional(),
});

export function inboxStateRoutes(db: Db) {
  const router = Router();

  function requireUserId(
    req: Parameters<Parameters<typeof router.post>[1]>[0],
  ): string {
    assertBoard(req);
    if (!req.actor.userId) {
      throw forbidden("User identity required for inbox state");
    }
    return req.actor.userId;
  }

  /**
   * Upsert helper — every mutation endpoint resolves down to this.
   * The UNIQUE(user_id, entity_type, entity_id) index makes the
   * upsert atomic; ON CONFLICT updates state + the relevant
   * timestamp column.
   */
  async function upsertState(params: {
    userId: string;
    entityType: (typeof INBOX_STATE_ENTITY_TYPES)[number];
    entityId: string;
    state: InboxState;
    snoozedUntil?: Date | null;
    readAt?: Date | null;
    archivedAt?: Date | null;
  }) {
    const now = new Date();
    const [row] = await db
      .insert(inboxState)
      .values({
        userId: params.userId,
        entityType: params.entityType,
        entityId: params.entityId,
        state: params.state,
        snoozedUntil: params.snoozedUntil ?? null,
        readAt: params.readAt ?? null,
        archivedAt: params.archivedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [inboxState.userId, inboxState.entityType, inboxState.entityId],
        set: {
          state: params.state,
          // Always update the relevant timestamp. The non-target
          // timestamps are intentionally NOT cleared — a row that
          // was once read keeps its read_at when it later gets
          // snoozed (forensic trail).
          snoozedUntil: params.snoozedUntil ?? sql`${inboxState.snoozedUntil}`,
          readAt: params.readAt ?? sql`${inboxState.readAt}`,
          archivedAt: params.archivedAt ?? sql`${inboxState.archivedAt}`,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  router.post("/inbox-state/snooze", async (req, res) => {
    const userId = requireUserId(req);
    const parsed = snoozeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("invalid snooze payload", parsed.error.flatten());
    }
    const snoozedUntil = new Date(parsed.data.snoozed_until);
    if (Number.isNaN(snoozedUntil.getTime())) {
      throw badRequest("snoozed_until is not a valid timestamp");
    }
    if (snoozedUntil.getTime() <= Date.now()) {
      throw badRequest("snoozed_until must be in the future");
    }
    const row = await upsertState({
      userId,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      state: "snoozed",
      snoozedUntil,
    });
    res.status(200).json({ ok: true, row });
  });

  router.post("/inbox-state/archive", async (req, res) => {
    const userId = requireUserId(req);
    const parsed = entityRefSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("invalid archive payload", parsed.error.flatten());
    }
    const row = await upsertState({
      userId,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      state: "archived",
      archivedAt: new Date(),
    });
    res.status(200).json({ ok: true, row });
  });

  router.post("/inbox-state/mark-read", async (req, res) => {
    const userId = requireUserId(req);
    const parsed = entityRefSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("invalid mark-read payload", parsed.error.flatten());
    }
    const row = await upsertState({
      userId,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      state: "read",
      readAt: new Date(),
    });
    res.status(200).json({ ok: true, row });
  });

  /**
   * Undo-archive: set state back to 'unread'. Used by the
   * QuickApprove 10s-undo banner (03-work-surfaces §A). Upserts so a
   * client calling undo on a never-archived row still gets a clean
   * 'unread' row rather than a 404.
   */
  router.post("/inbox-state/undo-archive", async (req, res) => {
    const userId = requireUserId(req);
    const parsed = entityRefSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("invalid undo-archive payload", parsed.error.flatten());
    }
    const row = await upsertState({
      userId,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      state: "unread",
      // Intentionally do NOT pass archivedAt — the ON CONFLICT
      // branch preserves the prior archived_at as a forensic trail
      // ("this was archived at T, then resurfaced at T+5s").
    });
    res.status(200).json({ ok: true, row });
  });

  /**
   * List the current user's inbox-state rows, optionally filtered by
   * one or more states. `?state=unread,snoozed` is the hot Inbox
   * query and hits idx_inbox_state_user_state (partial index).
   *
   * When `state` is omitted, returns every row for the user — used
   * by debug surfaces and the "include archived" toggle.
   */
  router.get("/inbox-state/me", async (req, res) => {
    const userId = requireUserId(req);
    const parsedQuery = meQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw badRequest(
        "invalid query parameters",
        parsedQuery.error.flatten(),
      );
    }

    let statesFilter: InboxState[] | null = null;
    if (parsedQuery.data.state) {
      const requested = parsedQuery.data.state
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const validated: InboxState[] = [];
      for (const value of requested) {
        const match = stateSchema.safeParse(value);
        if (!match.success) {
          throw badRequest(`invalid state filter: ${value}`);
        }
        validated.push(match.data);
      }
      statesFilter = validated;
    }

    const conditions = [eq(inboxState.userId, userId)];
    if (statesFilter && statesFilter.length > 0) {
      conditions.push(inArray(inboxState.state, statesFilter));
    }

    const rows = await db
      .select()
      .from(inboxState)
      .where(and(...conditions));

    res.json({ rows });
  });

  return router;
}
