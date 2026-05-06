/**
 * Company Memory service.
 *
 * Stores per-company intelligence entries: weekly summaries generated from
 * activity/cost/issue data, plus manual founder notes, milestones, and
 * experiment outcomes.
 *
 * generateWeeklySummary is idempotent per (companyId, weekStart): repeated
 * calls for the same ISO week update the existing row in place.
 */

import { and, eq, desc, gte, lt, sql, isNull, or, lte } from "drizzle-orm";
import type { Db } from "@founderos/db";
import { companyMemory, activityLog, issues, costEvents } from "@founderos/db";
import type {
  CompanyMemoryEntry,
  CreateCompanyMemoryInput,
  UpdateCompanyMemoryInput,
  MemoryKind,
  MemoryCategory,
} from "@founderos/shared";

function toEntry(row: typeof companyMemory.$inferSelect): CompanyMemoryEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as MemoryKind,
    title: row.title,
    body: row.body,
    topic: row.topic ?? null,
    occurredAt: row.occurredAt,
    pinned: row.pinned,
    source: row.source as "auto" | "manual",
    category: (row.category as MemoryCategory | null) ?? null,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Return Monday 00:00:00 UTC for the week containing `date`.
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday …
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function companyMemoryService(db: Db) {
  /**
   * List memory entries for a company, newest first.
   * Pinned entries are always sorted to the top.
   */
  async function list(
    companyId: string,
    opts?: {
      limit?: number;
      kind?: MemoryKind;
      pinned?: boolean;
      // S6.4 — when true, exclude rows whose expires_at < now().
      excludeExpired?: boolean;
    },
  ): Promise<CompanyMemoryEntry[]> {
    const conditions = [eq(companyMemory.companyId, companyId)];
    if (opts?.kind) {
      conditions.push(eq(companyMemory.kind, opts.kind));
    }
    if (opts?.pinned !== undefined) {
      conditions.push(eq(companyMemory.pinned, opts.pinned));
    }
    if (opts?.excludeExpired) {
      conditions.push(
        // expiresAt IS NULL OR expiresAt > now()
        or(isNull(companyMemory.expiresAt), sql`${companyMemory.expiresAt} > NOW()`)!,
      );
    }

    const rows = await db
      .select()
      .from(companyMemory)
      .where(and(...conditions))
      .orderBy(
        // pinned=true first (DESC boolean: true > false in postgres)
        desc(companyMemory.pinned),
        desc(companyMemory.occurredAt),
      )
      .limit(opts?.limit ?? 100);

    return rows.map(toEntry);
  }

  /**
   * S6.4 — agent recall query. Returns memories filtered by category
   * (and optionally by topic substring), newest first, with expired rows
   * excluded. This is the keyword-path; the embedding-cosine path can be
   * layered on top once an embedder is wired (it's a separate ORDER BY
   * over `embedding <=> $1` against the HNSW index).
   *
   * Always tenant-scoped.
   */
  async function recall(
    companyId: string,
    opts: {
      category?: MemoryCategory;
      topic?: string;
      limit?: number;
    },
  ): Promise<CompanyMemoryEntry[]> {
    const conditions = [
      eq(companyMemory.companyId, companyId),
      // Exclude expired rows by default for recall — TTL'd memory should
      // not influence future agent decisions.
      or(isNull(companyMemory.expiresAt), sql`${companyMemory.expiresAt} > NOW()`)!,
    ];

    if (opts.category) {
      conditions.push(eq(companyMemory.category, opts.category));
    }
    if (opts.topic) {
      // Topic substring match (case-insensitive). pg_trgm index would be
      // ideal here but the topic column doesn't have one yet; ILIKE on
      // a 100-char column is acceptable for typical row counts.
      conditions.push(sql`${companyMemory.topic} ILIKE ${"%" + opts.topic + "%"}`);
    }

    const rows = await db
      .select()
      .from(companyMemory)
      .where(and(...conditions))
      .orderBy(
        desc(companyMemory.pinned),
        desc(companyMemory.occurredAt),
      )
      .limit(opts.limit ?? 20);

    return rows.map(toEntry);
  }

  /**
   * S6.4 — TTL cleanup. Deletes rows whose `expires_at < now()`.
   * Returns the number of deleted rows.
   *
   * Tenant-scoped when companyId is provided; otherwise sweeps all
   * companies (for use by a system-wide cron).
   */
  async function purgeExpired(companyId?: string): Promise<number> {
    const conditions = [
      sql`${companyMemory.expiresAt} IS NOT NULL`,
      lte(companyMemory.expiresAt, new Date()),
    ];
    if (companyId) {
      conditions.push(eq(companyMemory.companyId, companyId));
    }

    const result = await db
      .delete(companyMemory)
      .where(and(...conditions))
      .returning({ id: companyMemory.id });

    return result.length;
  }

  /**
   * Create a new memory entry.
   */
  async function create(
    companyId: string,
    input: CreateCompanyMemoryInput & { source: "auto" | "manual" },
  ): Promise<CompanyMemoryEntry> {
    const now = new Date();
    const [row] = await db
      .insert(companyMemory)
      .values({
        companyId,
        kind: input.kind ?? "founder_note",
        title: input.title,
        body: input.body,
        topic: input.topic ?? null,
        occurredAt: input.occurredAt ?? now,
        pinned: input.pinned ?? false,
        source: input.source,
        category: input.category ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toEntry(row);
  }

  /**
   * Update title, body, topic, or pinned state.
   */
  async function update(
    id: string,
    patch: UpdateCompanyMemoryInput,
  ): Promise<CompanyMemoryEntry | null> {
    const now = new Date();
    const result = await db
      .update(companyMemory)
      .set({
        ...patch,
        updatedAt: now,
      })
      .where(eq(companyMemory.id, id))
      .returning();

    return result[0] ? toEntry(result[0]) : null;
  }

  /**
   * Delete a memory entry. Returns true if a row was removed.
   */
  async function remove(id: string): Promise<boolean> {
    const result = await db
      .delete(companyMemory)
      .where(eq(companyMemory.id, id))
      .returning();

    return result.length > 0;
  }

  /**
   * Toggle the pinned state of an entry.
   */
  async function togglePin(id: string): Promise<CompanyMemoryEntry | null> {
    // Read current state, then flip
    const [current] = await db
      .select()
      .from(companyMemory)
      .where(eq(companyMemory.id, id));

    if (!current) return null;

    return update(id, { pinned: !current.pinned });
  }

  /**
   * Generate (or refresh) a weekly summary entry for the given company and week.
   *
   * weekOfISO: ISO date string "YYYY-MM-DD" for any day within the target week.
   * The entry is keyed to Monday 00:00 UTC. Idempotent.
   */
  async function generateWeeklySummary(
    companyId: string,
    weekOfISO: string,
  ): Promise<CompanyMemoryEntry> {
    const weekStart = getWeekStart(new Date(weekOfISO));
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    // --- 1. Activity: count heartbeat shifts and distinct agent ids -----------
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          gte(activityLog.createdAt, weekStart),
          lt(activityLog.createdAt, weekEnd),
        ),
      );

    const shiftsRun = activityRows.filter((r) =>
      r.action.startsWith("heartbeat."),
    ).length;

    const teammatesInvolved = new Set(
      activityRows
        .filter((r) => r.agentId != null)
        .map((r) => r.agentId as string),
    ).size;

    // --- 2. Issues closed this week -------------------------------------------
    // Issues have completedAt when done; fall back to updatedAt if needed.
    const closedRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          gte(issues.updatedAt, weekStart),
          lt(issues.updatedAt, weekEnd),
        ),
      );

    const issuesShipped = closedRows.length;
    const topTitles = closedRows
      .slice(0, 3)
      .map((i) => i.title)
      .join(", ");

    // --- 3. Spend for the week ------------------------------------------------
    const costRows = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, weekStart),
          lt(costEvents.occurredAt, weekEnd),
        ),
      );

    const spendCents = costRows.reduce((sum, r) => sum + r.costCents, 0);
    const spendDollars = (spendCents / 100).toFixed(2);

    // --- 4. Build body --------------------------------------------------------
    const shiftLine = `${shiftsRun} shift${shiftsRun === 1 ? "" : "s"} run across ${teammatesInvolved} teammate${teammatesInvolved === 1 ? "" : "s"}.`;
    const shippedLine =
      issuesShipped > 0
        ? `Shipped ${issuesShipped} issue${issuesShipped === 1 ? "" : "s"}${topTitles ? `: ${topTitles}` : ""}.`
        : "No issues shipped this week.";
    const spendLine = `Spend: $${spendDollars}.`;

    const body = [
      `Week of ${formatDate(weekStart)}.`,
      shiftLine,
      shippedLine,
      spendLine,
    ].join("\n");

    const title = `Week of ${formatDate(weekStart)} · ${issuesShipped} shipped`;

    // --- 5. Upsert (idempotent per companyId + weekStart) ---------------------
    // Check for an existing auto weekly_summary for this exact week start
    const [existing] = await db
      .select()
      .from(companyMemory)
      .where(
        and(
          eq(companyMemory.companyId, companyId),
          eq(companyMemory.kind, "weekly_summary"),
          eq(companyMemory.source, "auto"),
          sql`DATE_TRUNC('day', ${companyMemory.occurredAt} AT TIME ZONE 'UTC') = ${weekStart.toISOString().slice(0, 10)}::date`,
        ),
      );

    if (existing) {
      const updated = await update(existing.id, { title, body });
      return updated!;
    }

    return create(companyId, {
      kind: "weekly_summary",
      title,
      body,
      topic: null,
      occurredAt: weekStart,
      pinned: false,
      source: "auto",
    });
  }

  return {
    list,
    recall,
    purgeExpired,
    create,
    update,
    remove,
    togglePin,
    generateWeeklySummary,
  };
}
