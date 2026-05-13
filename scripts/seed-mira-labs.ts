#!/usr/bin/env tsx
/**
 * seed-mira-labs.ts — FounderOS Mira Labs dogfood persona seed (TD-1)
 *
 * Creates a complete "Anita Mehra / Mira Labs" dogfood persona in the
 * FounderOS Fly Postgres database (the app-side DB, NOT Supabase auth).
 *
 * Council conditions satisfied (COUNCIL-VERDICT.md TD-1, 2026-05-13):
 *   #1 — Explicit seed sequence: Supabase Admin API → runPostSignupBootstrap
 *        → Drizzle inserts. Log line "Calling runPostSignupBootstrap for <uid>..."
 *   #2 — Top-of-file idempotency check on metadata->>'persona' = 'mira-labs-dogfood'.
 *        Aborts with clear message if found and RESET=1 not set.
 *   #3 — DB trigger (migration 0109) prevents is_demo=true on this company.
 *        The seed inserts is_demo: false.
 *   #4 — ZERO instance_api_keys rows seeded. Vinamr enters keys via UI on wake-up.
 *   #5 — Approvals with draft_placeholder_* gmailDraftId are safe seed data;
 *        execution guard lives in server/src/services/approvals.ts:approve().
 *
 * Run:
 *   FOUNDEROS_SEED_MIRA_LABS=1 DATABASE_URL=<fly-proxy-url> pnpm tsx scripts/seed-mira-labs.ts
 *
 * Re-seed (purge + re-insert):
 *   FOUNDEROS_SEED_MIRA_LABS=1 FOUNDEROS_SEED_MIRA_LABS_RESET=1 \
 *     DATABASE_URL=<fly-proxy-url> pnpm tsx scripts/seed-mira-labs.ts
 *
 * Supabase auth user (bajajvinamr+anita@gmail.com) must be created separately
 * via the Supabase Admin API or dashboard BEFORE running this script.
 * The ANITA_AUTH_UID env var must be set to the returned user UUID.
 * If not set, the script will attempt to create the user via Admin API
 * (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *
 * See docs/ops/mira-labs-wake-up.md (TD-7) for the full wake-up runbook.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../packages/db/src/client.js";
import {
  companies,
  agents,
  goals,
  projects,
  issues,
  approvals,
  companyMemberships,
  composioConnections,
  dailyBriefs,
} from "../packages/db/src/schema/index.js";
import type { DailyBriefPayload } from "../packages/db/src/schema/daily_briefs.js";
import { runPostSignupBootstrap } from "../server/src/auth/post-signup-hook.js";

// ─── Gate: FOUNDEROS_SEED_MIRA_LABS=1 ────────────────────────────────────────

if (process.env.FOUNDEROS_SEED_MIRA_LABS !== "1") {
  console.error(
    "[seed-mira-labs] Refusing to run: this script inserts the Mira Labs dogfood persona\n" +
      "into the configured DATABASE_URL. Set FOUNDEROS_SEED_MIRA_LABS=1 to confirm\n" +
      "you are pointing at the correct database. Never run against a buyer tenant.",
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[seed-mira-labs] DATABASE_URL is required.");
  process.exit(1);
}

const RESET = process.env.FOUNDEROS_SEED_MIRA_LABS_RESET === "1";

const ANITA_EMAIL = "bajajvinamr+anita@gmail.com";
const ANITA_NAME = "Anita Mehra";
const ANITA_PASSWORD = "MiraLabs2026!";
const PERSONA_TAG = "mira-labs-dogfood";

// ─── Supabase Auth UID resolution ─────────────────────────────────────────────
// The seed must resolve ANITA_AUTH_UID before any Drizzle inserts.
// Two paths:
//   A. ANITA_AUTH_UID env var is already set (fastest, used in CI/automated runs).
//   B. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set → call Admin API
//      to create-or-find the user (idempotent).

const SupabaseUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});

const SupabaseUserListSchema = z.object({
  users: z.array(SupabaseUserSchema),
  total: z.number().optional(),
  nextPage: z.number().optional(),
});

async function resolveAnitaAuthUid(): Promise<string> {
  // Path A: explicit UID provided
  const envUid = process.env.ANITA_AUTH_UID;
  if (envUid && envUid.trim().length > 0) {
    console.log(`[seed-mira-labs] Using ANITA_AUTH_UID from environment: ${envUid}`);
    return envUid.trim();
  }

  // Path B: use Supabase Admin API (create-or-find)
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[seed-mira-labs] Cannot resolve Anita's Supabase auth UID.\n" +
        "Either:\n" +
        "  A. Set ANITA_AUTH_UID=<uuid> in the environment, OR\n" +
        "  B. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY so the script can\n" +
        "     call the Admin API to create-or-find the user.\n" +
        "\n" +
        "To create manually via Supabase dashboard:\n" +
        "  Authentication → Users → Add user\n" +
        `  Email: ${ANITA_EMAIL}\n` +
        `  Password: ${ANITA_PASSWORD}\n` +
        "  Email confirmed: yes\n" +
        "  user_metadata.full_name: Anita Mehra\n" +
        "  user_metadata.company_name: Mira Labs\n" +
        "Then set ANITA_AUTH_UID=<returned UUID> and re-run.",
    );
    process.exit(1);
  }

  // Try to find existing user first (idempotent)
  const listUrl = `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`;
  let foundUid: string | null = null;

  try {
    const listRes = await fetch(listUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (listRes.ok) {
      const listData = SupabaseUserListSchema.safeParse(await listRes.json());
      if (listData.success) {
        const existing = listData.data.users.find((u) => u.email === ANITA_EMAIL);
        if (existing) {
          console.log(
            `[seed-mira-labs] Found existing Supabase user for ${ANITA_EMAIL}: ${existing.id}`,
          );
          foundUid = existing.id;
        }
      }
    }
  } catch (err) {
    console.warn(
      `[seed-mira-labs] Warning: could not list Supabase users (will try create): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (foundUid) return foundUid;

  // Create new user
  const createUrl = `${supabaseUrl}/auth/v1/admin/users`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      email: ANITA_EMAIL,
      password: ANITA_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: ANITA_NAME,
        company_name: "Mira Labs",
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error(
      `[seed-mira-labs] Supabase Admin API user creation failed (HTTP ${createRes.status}):\n${errText}\n\n` +
        "Fix the Supabase error above, or create the user manually and set ANITA_AUTH_UID.",
    );
    process.exit(1);
  }

  const createData = SupabaseUserSchema.safeParse(await createRes.json());
  if (!createData.success) {
    console.error(
      "[seed-mira-labs] Supabase Admin API returned unexpected shape. Set ANITA_AUTH_UID manually.",
    );
    process.exit(1);
  }

  console.log(
    `[seed-mira-labs] Created Supabase user for ${ANITA_EMAIL}: ${createData.data.id}`,
  );
  return createData.data.id;
}

// ─── TD-2: Pre-seed daily brief ───────────────────────────────────────────────

/**
 * seedMiraLabsDailyBrief — inserts a pre-baked daily_briefs row for today.
 *
 * This is TD-2. On first login the `/brief` route returns empty for a freshly-
 * seeded company because no daily_briefs row exists and the 7am cron hasn't
 * fired yet. Inserting a synthetic row here means the first-impression journey
 * (mira-labs-spec §5, Step 3) is not blank.
 *
 * Content mirrors the DailyBriefPayload shape defined in daily_briefs.ts and
 * is verbatim from mira-labs-spec.md §2 Agent 1 expected output.
 *
 * Idempotency: ON CONFLICT (company_id, for_date) DO NOTHING — running the
 * seed script twice will not create a second brief row for today.
 *
 * @param db       — Drizzle DB instance
 * @param companyId — Mira Labs company UUID
 * @param acmeRetailApprovalId — UUID of the Acme Retail proposal approval (a3)
 * @param bakeHouseApprovalId  — UUID of the Bake House invoice approval (a4)
 */
async function seedMiraLabsDailyBrief(
  db: ReturnType<typeof createDb>,
  companyId: string,
  acmeRetailApprovalId: string,
  bakeHouseApprovalId: string,
): Promise<void> {
  // IST local date at run time. The brief is intended for "today" from Anita's
  // perspective (digest_timezone = "Asia/Kolkata"). We compute it with the same
  // Intl helper the production cron uses so the brief's forDate matches what
  // `GET /api/companies/:id/daily-briefs?forDate=today` would resolve to.
  const todayIst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const payload: DailyBriefPayload = {
    headline:
      "2 client emails need replies; Acme Retail proposal draft ready for your review.",
    topThreeActions: [
      {
        action: "Review and approve Acme Retail proposal draft",
        rationale:
          "Theo completed a first draft based on your discovery notes. Proposal: AI Customer-Support Automation — $2,200/mo + $3,500 setup. Sending deadline: Friday.",
        approvalId: acmeRetailApprovalId,
      },
      {
        action: "Reply to Northwood Dental — they're asking about next month's scope",
        rationale:
          "Email arrived 8pm yesterday. They haven't signed next month yet. A quick reply confirming June scope keeps the renewal on track.",
        approvalId: undefined,
      },
      {
        action: "Chase Bake House invoice — 6 days overdue",
        rationale:
          "Iris flagged $1,200 outstanding. Stripe last charge: May 7 (overdue by 6 days). Approve the payment reminder to unblock this.",
        approvalId: bakeHouseApprovalId,
      },
    ],
    kpiMovements: [
      {
        metric: "MRR",
        from: "$6,400",
        to: "$6,400",
        delta: "flat",
        commentary:
          "4 active retainers. Bake House payment pending ($1,200). Fielding Logistics discovery call tomorrow — potential $2K/mo.",
      },
    ],
    anomalies: [],
    blockers: [
      {
        title: "Bake House invoice 6 days overdue",
        resolutionAction:
          "Send payment reminder via Stripe; Iris has drafted the email — approve from Inbox.",
      },
    ],
    opportunities: [
      {
        title: "Fielding Logistics discovery call — May 14",
        expectedImpact: "Potential $2,000/mo retainer (120-person freight company).",
        insightId: "",
      },
    ],
  };

  console.log(
    `[seed-mira-labs] Inserting daily brief for ${todayIst} (IST) — ON CONFLICT DO NOTHING…`,
  );

  // onConflictDoNothing() hits the unique index (company_id, for_date) —
  // first-write-wins. A re-run of the seed script for the same day is a no-op.
  await db
    .insert(dailyBriefs)
    .values({
      companyId,
      forDate: todayIst,
      payload,
    })
    .onConflictDoNothing();

  console.log("[seed-mira-labs] Daily brief row upserted (or already existed).");
}

// ─── Reset path ───────────────────────────────────────────────────────────────

async function purgeExistingMiraLabs(db: ReturnType<typeof createDb>): Promise<void> {
  console.log("[seed-mira-labs] RESET=1: purging existing Mira Labs data (reverse dep order)…");

  // Find the company ID first
  const existingCompany = await db
    .select({ id: companies.id })
    .from(companies)
    .where(sql`${companies.metadata}->>'persona' = ${PERSONA_TAG}`)
    .then((rows) => rows[0] ?? null);

  if (!existingCompany) {
    console.log("[seed-mira-labs] No existing Mira Labs data found — reset is a no-op.");
    return;
  }

  const companyId = existingCompany.id;

  // Reverse topological order: daily_briefs → approvals → issues → projects → goals →
  // composio_connections → agents → company_memberships → companies → user
  await db.delete(dailyBriefs).where(sql`${dailyBriefs.companyId} = ${companyId}::uuid`);
  await db.delete(approvals).where(sql`${approvals.companyId} = ${companyId}::uuid`);
  await db.delete(issues).where(sql`${issues.companyId} = ${companyId}::uuid`);
  await db.delete(projects).where(sql`${projects.companyId} = ${companyId}::uuid`);
  await db.delete(goals).where(sql`${goals.companyId} = ${companyId}::uuid`);
  await db.delete(composioConnections).where(sql`${composioConnections.companyId} = ${companyId}::uuid`);
  await db.delete(agents).where(sql`${agents.companyId} = ${companyId}::uuid`);
  await db.delete(companyMemberships).where(sql`${companyMemberships.companyId} = ${companyId}::uuid`);
  await db.delete(companies).where(sql`${companies.id} = ${companyId}::uuid`);

  // Note: public."user" row is NOT deleted. The Supabase auth user is also NOT
  // deleted (it's on a different DB host and requires manual action via the
  // Supabase dashboard). The reset only purges the app-side data.
  console.log(
    `[seed-mira-labs] Purged Mira Labs company ${companyId} and all dependent rows.`,
  );
}

// ─── Main seed function ───────────────────────────────────────────────────────

async function seedMiraLabs(): Promise<void> {
  const db = createDb(DATABASE_URL!);

  // ── Council condition #2: top-of-file idempotency check ────────────────────
  const existingPersona = await db
    .select({ id: companies.id })
    .from(companies)
    .where(sql`${companies.metadata}->>'persona' = ${PERSONA_TAG}`)
    .then((rows) => rows[0] ?? null);

  if (existingPersona && !RESET) {
    console.error(
      `[seed-mira-labs] Mira Labs already seeded (company ${existingPersona.id}).\n` +
        "Pass FOUNDEROS_SEED_MIRA_LABS_RESET=1 to purge and re-seed.",
    );
    process.exit(1);
  }

  if (RESET) {
    await purgeExistingMiraLabs(db);
  }

  // ── Resolve Anita's auth UID ────────────────────────────────────────────────
  const ANITA_AUTH_UID = await resolveAnitaAuthUid();

  // ── Council condition #1: call runPostSignupBootstrap directly ─────────────
  // This is the same code path the first authenticated request would take.
  // It atomically upserts the public."user" mirror row AND grants base roles.
  // NEVER insert into instance_user_roles directly — bootstrap handles it.
  console.log(`[seed-mira-labs] Calling runPostSignupBootstrap for ${ANITA_AUTH_UID}...`);
  const bootstrapResult = await runPostSignupBootstrap(db, {
    userId: ANITA_AUTH_UID,
    email: ANITA_EMAIL,
    name: ANITA_NAME,
  });
  console.log(
    `[seed-mira-labs] Bootstrap complete: promotedToInstanceAdmin=${bootstrapResult.promotedToInstanceAdmin}, consumedInvite=${bootstrapResult.consumedInvite?.id ?? null}`,
  );

  // ── Company ─────────────────────────────────────────────────────────────────
  console.log("[seed-mira-labs] Inserting Mira Labs company…");
  const [company] = await db
    .insert(companies)
    .values({
      name: "Mira Labs",
      description:
        "AI/automation consultancy for SMBs. Helps non-technical founders implement back-office AI — workflow audits, custom Claude/GPT assistants, monthly retainer support.",
      status: "active",
      issuePrefix: "MIR",
      issueCounter: 5, // 5 issues already seeded (MIR-001…MIR-005)
      budgetMonthlyCents: 50_000, // $500/mo agent budget
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: true,
      feedbackDataSharingEnabled: false,
      brandColor: "#7c3aed",
      isDemo: false, // Council condition #3: real persona, NOT demo data
      metadata: {
        persona: PERSONA_TAG, // idempotency key + is_demo trigger guard
      },
      metrics: {
        stage: "Bootstrapped · Year 1",
        tagline: "AI automation consultancy for SMBs · 4 retainer clients",
        mrrCents: 640_000, // $6,400 MRR
        pipelineCount: 3,
        pipelineCents: 720_000, // $7,200 weighted pipeline ACV
        customersSigned: 4,
        monthlyBurnCents: 180_000, // $1,800
        runwayMonths: 18,
        keyAccounts: [
          "Northwood Dental",
          "Bake House",
          "Clearview Legal",
          "Fielding Logistics (scoping)",
        ],
        nextMilestoneLabel: "$10K MRR by Aug 2026",
        deltas: {
          mrr: { dir: "up", text: "+$800 MoM" },
          pipeline: { dir: "up", text: "+2 prospects" },
          monthlyBurn: { dir: "flat", text: "stable" },
        },
        weeklyWrapSlackChannelId: "", // set after Slack OAuth
      },
    })
    .returning();

  if (!company) throw new Error("[seed-mira-labs] Company insert returned no rows");
  const MIRA_COMPANY_ID = company.id;
  console.log(`[seed-mira-labs] Company inserted: ${MIRA_COMPANY_ID}`);

  // ── Membership: Anita as owner ───────────────────────────────────────────────
  await db.insert(companyMemberships).values({
    companyId: MIRA_COMPANY_ID,
    principalType: "user",
    principalId: ANITA_AUTH_UID,
    status: "active",
    membershipRole: "owner",
    digestEnabled: true,
    digestHourLocal: 8,
    digestTimezone: "Asia/Kolkata",
  });
  console.log("[seed-mira-labs] Membership inserted (Anita as owner).");

  // ── Agents ───────────────────────────────────────────────────────────────────
  console.log("[seed-mira-labs] Inserting agents (Maya / Theo / Iris)…");

  const MAYA_PROMPT = `You are Maya, Chief of Staff at Mira Labs. Anita Mehra is your founder.
Today is {{date}}. Your job each morning:
1. Read the last 24h of messages in Slack #mira-team and any #client-* channels you can access.
2. Search Gmail for unread threads from the last 24h containing client names: {{client_names_csv}}.
3. Pull all pending approvals from FounderOS (status: pending, company: Mira Labs).
4. Write a DailyBrief with:
   - headline: 1 line summary of the day
   - topThreeActions: exactly 3 items, each with an approvalId if an approval exists
   - kpiMovements: any MRR or invoice changes
   - blockers: any overdue items
   - opportunities: any inbound interest or upsell signals
Output the JSON directly. Do not add prose outside the JSON schema.`;

  const THEO_PROMPT = `You are Theo, Growth & BD agent at Mira Labs, an AI automation consultancy.
When given a discovery call transcript or brief, produce a client proposal with:
- Executive summary (3 sentences)
- Scope: 3–5 bullet deliverables with effort estimates
- Pricing: Monthly retainer (recommend $1,500–$3,000 based on scope) + one-time setup fee
- Next steps: Kick-off call date + contract signing timeline
Style: Consultancy-grade. Concise. No jargon. Show value in terms of hours saved or revenue enabled.

Client context: {{client_name}}, {{client_industry}}, {{pain_points}}.
Discovery notes: {{discovery_notes}}

After generating the proposal, create an approval request in FounderOS so Anita can review before anything is sent.`;

  const IRIS_PROMPT = `You are Iris, Finance agent at Mira Labs.
Run on the 1st and 15th of each month, and on-demand when triggered.

Tasks:
1. INVOICE CHECK: Query Stripe for all open invoices. Flag any overdue >5 days. Create an approval request for each: "Send payment reminder to {{client_name}} — {{amount}} due {{date}}."
2. MONTHLY RETAINER SUMMARY: On the 1st, for each client, generate a 1-page summary:
   - What was delivered this month (from FounderOS issues completed + Slack #client-* activity)
   - MRR contribution
   - Upcoming deliverables next month
   Draft as Gmail draft for Anita to review and send.
3. FINANCE DIGEST: Post a weekly Slack summary to #mira-finance: MRR, outstanding invoices, runway estimate at current burn.

Current clients: {{client_list_with_stripe_ids}}`;

  const [maya] = await db
    .insert(agents)
    .values({
      companyId: MIRA_COMPANY_ID,
      name: "Maya",
      role: "chief_of_staff",
      title: "Chief of Staff — Mira Labs",
      icon: "🗂️",
      status: "idle",
      reportsTo: null,
      capabilities:
        "Reads Slack + Gmail, synthesises into a daily brief, surfaces pending approvals. Anita's morning briefing agent.",
      adapterType: "anthropic_api",
      adapterConfig: {
        model: "claude-opus-4-6",
        maxTurnsPerRun: 20,
        dangerouslySkipPermissions: false,
        promptTemplate: MAYA_PROMPT,
      },
      budgetMonthlyCents: 15_000, // $150
      permissionLevel: "approve",
      permissions: {},
      metadata: { persona: PERSONA_TAG, integrations: ["slack", "gmail"] },
    })
    .returning();
  if (!maya) throw new Error("[seed-mira-labs] Maya insert returned no rows");
  const MAYA_ID = maya.id;

  const [theo] = await db
    .insert(agents)
    .values({
      companyId: MIRA_COMPANY_ID,
      name: "Theo",
      role: "head_of_growth",
      title: "Growth & BD — Mira Labs",
      icon: "📈",
      status: "idle",
      reportsTo: null,
      capabilities:
        "Drafts client proposals from discovery notes. Tracks prospect pipeline. Posts to #pipeline Slack.",
      adapterType: "openai_api",
      adapterConfig: {
        model: "gpt-4.1-mini",
        maxTurnsPerRun: 15,
        dangerouslySkipPermissions: false,
        promptTemplate: THEO_PROMPT,
      },
      budgetMonthlyCents: 10_000, // $100
      permissionLevel: "approve",
      permissions: {},
      metadata: { persona: PERSONA_TAG, integrations: ["gmail", "slack"] },
    })
    .returning();
  if (!theo) throw new Error("[seed-mira-labs] Theo insert returned no rows");
  const THEO_ID = theo.id;

  const [iris] = await db
    .insert(agents)
    .values({
      companyId: MIRA_COMPANY_ID,
      name: "Iris",
      role: "finance",
      title: "Finance Agent — Mira Labs",
      icon: "💰",
      status: "idle",
      reportsTo: null,
      capabilities:
        "Checks Stripe invoices, flags overdue payments, drafts monthly retainer summaries. Runs 1st and 15th.",
      adapterType: "anthropic_api",
      adapterConfig: {
        model: "claude-sonnet-4-6",
        maxTurnsPerRun: 15,
        dangerouslySkipPermissions: false,
        promptTemplate: IRIS_PROMPT,
      },
      budgetMonthlyCents: 8_000, // $80
      permissionLevel: "approve",
      permissions: {},
      metadata: { persona: PERSONA_TAG, integrations: ["stripe", "gmail", "slack"] },
    })
    .returning();
  if (!iris) throw new Error("[seed-mira-labs] Iris insert returned no rows");
  const IRIS_ID = iris.id;

  console.log(`[seed-mira-labs] Agents inserted: Maya=${MAYA_ID}, Theo=${THEO_ID}, Iris=${IRIS_ID}`);

  // ── Goals (3) ───────────────────────────────────────────────────────────────
  console.log("[seed-mira-labs] Inserting goals…");

  const [goal1] = await db
    .insert(goals)
    .values({
      companyId: MIRA_COMPANY_ID,
      title: "Hit $10K MRR by August 2026",
      description:
        "Add 2 net-new retainer clients ($1,500–$2,000/mo each) and expand one existing client. Pipeline: Acme Retail ($2K), Fielding Logistics ($2K), SkyBridge Insurance ($1.5K).",
      level: "company",
      status: "active",
      ownerAgentId: THEO_ID,
    })
    .returning();
  if (!goal1) throw new Error("[seed-mira-labs] Goal 1 insert failed");
  const GOAL_1_ID = goal1.id;

  const [goal2] = await db
    .insert(goals)
    .values({
      companyId: MIRA_COMPANY_ID,
      title: "Reduce proposal drafting time from 4h to 30min",
      description:
        "Theo generates first-draft proposals from discovery transcript within 10 minutes. Anita edits and approves. Target: 5 proposals generated and approved in Q2.",
      level: "company",
      status: "active",
      ownerAgentId: THEO_ID,
    })
    .returning();
  if (!goal2) throw new Error("[seed-mira-labs] Goal 2 insert failed");

  const [goal3] = await db
    .insert(goals)
    .values({
      companyId: MIRA_COMPANY_ID,
      title: "Zero churn — all 4 retainer clients renewed through Q3",
      description:
        "Iris sends monthly retainer summaries automatically. Maya flags any client at risk based on communication drop-off. Target: 100% renewal at or above current rate.",
      level: "company",
      status: "active",
      ownerAgentId: IRIS_ID,
    })
    .returning();
  if (!goal3) throw new Error("[seed-mira-labs] Goal 3 insert failed");
  const GOAL_3_ID = goal3.id;

  console.log(`[seed-mira-labs] Goals inserted: ${GOAL_1_ID}, ${goal2.id}, ${GOAL_3_ID}`);

  // ── Project (1) ─────────────────────────────────────────────────────────────
  const [project] = await db
    .insert(projects)
    .values({
      companyId: MIRA_COMPANY_ID,
      goalId: GOAL_1_ID,
      name: "Q2 Client Pipeline",
      description:
        "Active prospect pipeline for Q2 2026. 3 prospects: Acme Retail, Fielding Logistics, SkyBridge Insurance. Target: 2 signed by June 30.",
      status: "in_progress",
      leadAgentId: THEO_ID,
      targetDate: "2026-06-30",
      color: "#7c3aed",
    })
    .returning();
  if (!project) throw new Error("[seed-mira-labs] Project insert failed");
  const Q2_PROJECT_ID = project.id;
  console.log(`[seed-mira-labs] Project inserted: ${Q2_PROJECT_ID}`);

  // ── Issues (5) ──────────────────────────────────────────────────────────────
  // Note: issues.identifier has a UNIQUE constraint. The identifiers MIR-001
  // through MIR-005 must not already exist in the DB. The idempotency check
  // at the top of this script guards against double-insertion.
  console.log("[seed-mira-labs] Inserting 5 issues (MIR-001 … MIR-005)…");

  await db.insert(issues).values([
    {
      companyId: MIRA_COMPANY_ID,
      projectId: Q2_PROJECT_ID,
      goalId: GOAL_1_ID,
      title: "Acme Retail — AI customer-support automation pitch",
      description:
        "Met at Nasscom event 2026-05-08. Anita's notes: 50-person retail chain, 8K support tickets/month, 2 support staff. Pain: resolution time 48h avg, target 4h. Interested in AI triage + response draft. Budget ~$2K/mo.",
      status: "in_progress",
      priority: "urgent",
      identifier: "MIR-001",
      assigneeAgentId: THEO_ID,
      originKind: "manual",
    },
    {
      companyId: MIRA_COMPANY_ID,
      projectId: Q2_PROJECT_ID,
      goalId: GOAL_1_ID,
      title: "Fielding Logistics — back-office AI audit",
      description:
        "Discovery call booked: May 14. Head of Ops, 120-person freight company. Pain: invoice reconciliation is manual (3 FTE, 4 days/mo). Possible scope: AI reconciliation + anomaly detection. Budget unknown.",
      status: "todo",
      priority: "high",
      identifier: "MIR-002",
      assigneeAgentId: THEO_ID,
      originKind: "manual",
    },
    {
      companyId: MIRA_COMPANY_ID,
      projectId: Q2_PROJECT_ID,
      goalId: GOAL_1_ID,
      title: "SkyBridge Insurance — customer onboarding workflow audit",
      description:
        "Warm intro from Northwood Dental. Insurance broker, 25 staff. Pain: new-client onboarding 2 weeks. Interested in AI-assisted document collection + checklist. Budget $1,500/mo. First call not yet booked.",
      status: "backlog",
      priority: "medium",
      identifier: "MIR-003",
      assigneeAgentId: THEO_ID,
      originKind: "manual",
    },
    {
      companyId: MIRA_COMPANY_ID,
      projectId: Q2_PROJECT_ID,
      goalId: GOAL_3_ID,
      title: "Bake House invoice overdue — send reminder",
      description:
        "Stripe: $1,200 due May 7. Now 6 days overdue. Iris to draft payment reminder email. Requires Anita approval before sending.",
      status: "todo",
      priority: "urgent",
      identifier: "MIR-004",
      assigneeAgentId: IRIS_ID,
      originKind: "manual",
    },
    {
      companyId: MIRA_COMPANY_ID,
      projectId: Q2_PROJECT_ID,
      goalId: GOAL_3_ID,
      title: "Northwood Dental — April retainer summary draft",
      description:
        "Monthly summary due May 15. Iris to compile: 3 tickets closed in Linear, Slack activity summary, next month scope. Draft for Anita to review and send.",
      status: "in_progress",
      priority: "high",
      identifier: "MIR-005",
      assigneeAgentId: IRIS_ID,
      originKind: "manual",
    },
  ]);
  console.log("[seed-mira-labs] Issues inserted (MIR-001 … MIR-005).");

  // ── Approvals (5) — the Inbox ────────────────────────────────────────────────
  // Council condition #5 acceptance: gmailDraftId values matching
  // /^draft_placeholder_\d+$/ are safe seed data (demo-only). They will
  // never reach a real Composio call because approvals.ts:approve() guards
  // them with a soft error before any execution path fires.
  //
  // Council condition #4: NO instance_api_keys rows inserted here.
  // Vinamr enters API keys via Settings → Providers on wake-up.
  console.log("[seed-mira-labs] Inserting 5 approvals (Inbox items)…");

  const [a1, a2, a3, a4, a5] = await db
    .insert(approvals)
    .values([
      {
        companyId: MIRA_COMPANY_ID,
        type: "agent_action",
        requestedByAgentId: MAYA_ID,
        status: "pending",
        payload: {
          action: "post_slack_message",
          channel: "#pipeline",
          message:
            "Good morning, Mira Labs team. Today's priorities: (1) Acme Retail proposal ready for Anita's review, (2) Bake House invoice 6 days overdue, (3) Fielding Logistics discovery call prep needed for May 14.",
          summary: "Daily team standup message — Maya's morning brief to #mira-team",
          agentName: "Maya",
          requiresApproval: true,
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      },
      {
        companyId: MIRA_COMPANY_ID,
        type: "agent_action",
        requestedByAgentId: MAYA_ID,
        status: "pending",
        payload: {
          action: "send_email",
          to: "ops@northwooddental.com",
          subject: "Checking in — next month scope confirmation",
          preview:
            "Hi Sarah, following up on our May retainer — wanted to confirm the scope for June before I send the renewal invoice...",
          summary: "Reply to Northwood Dental inquiry re next month scope",
          agentName: "Maya",
          requiresApproval: true,
          // Placeholder: execution guard in approvals.ts:approve() rejects
          // any Composio call when gmailDraftId matches /^draft_placeholder_\d+$/
          gmailDraftId: "draft_placeholder_001",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      },
      {
        companyId: MIRA_COMPANY_ID,
        type: "agent_action",
        requestedByAgentId: THEO_ID,
        status: "pending",
        payload: {
          action: "send_proposal",
          prospect: "Acme Retail",
          proposalTitle: "AI Customer-Support Automation — Mira Labs Proposal",
          scope:
            "4-week audit + 3-month implementation retainer. Deliverables: support-ticket AI triage, response-draft assistant, escalation workflow. Pricing: $3,500 setup + $2,200/mo.",
          deliveryMethod: "gmail_draft",
          to: "ops@acmeretail.com",
          summary: "Send Acme Retail proposal — $2,200/mo + $3,500 setup",
          agentName: "Theo",
          requiresApproval: true,
          gmailDraftId: "draft_placeholder_002",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      },
      {
        companyId: MIRA_COMPANY_ID,
        type: "agent_action",
        requestedByAgentId: IRIS_ID,
        status: "pending",
        payload: {
          action: "send_payment_reminder",
          client: "Bake House",
          amount: "$1,200",
          daysPastDue: 6,
          to: "billing@bakehouse.co",
          subject: "Invoice reminder — Mira Labs May retainer",
          preview:
            "Hi Jason, just a friendly reminder that the May invoice ($1,200) was due May 7 — if there's anything I can help with on the billing side...",
          summary: "Send payment reminder to Bake House — $1,200 overdue",
          agentName: "Iris",
          requiresApproval: true,
          gmailDraftId: "draft_placeholder_003",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      },
      {
        companyId: MIRA_COMPANY_ID,
        type: "agent_action",
        requestedByAgentId: IRIS_ID,
        status: "pending",
        payload: {
          action: "send_retainer_summary",
          client: "Northwood Dental",
          month: "April 2026",
          to: "dr.sharma@northwooddental.com",
          subject: "Mira Labs — April 2026 summary",
          preview:
            "Hi Dr. Sharma, here's your April summary from Mira Labs. Delivered this month: (1) AI intake form processor deployed, (2) Appointment-reminder workflow live...",
          summary: "Send April retainer summary to Northwood Dental",
          agentName: "Iris",
          requiresApproval: true,
          gmailDraftId: "draft_placeholder_004",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      },
    ])
    .returning();

  const approvalCount = [a1, a2, a3, a4, a5].filter(Boolean).length;
  console.log(`[seed-mira-labs] Approvals inserted: ${approvalCount}/5.`);

  // ── Composio connections (3 — pending OAuth) ─────────────────────────────────
  // status: "pending" — agents degrade gracefully until Vinamr completes OAuth
  // on wake-up. The composio_connections.composioConnectionId is a placeholder;
  // it will be updated to a real Composio ID when OAuth completes.
  console.log("[seed-mira-labs] Inserting 3 Composio connection placeholders…");

  await db.insert(composioConnections).values([
    {
      companyId: MIRA_COMPANY_ID,
      userId: ANITA_AUTH_UID,
      appName: "slack",
      composioConnectionId: "pending_oauth_slack",
      status: "pending",
    },
    {
      companyId: MIRA_COMPANY_ID,
      userId: ANITA_AUTH_UID,
      appName: "gmail",
      composioConnectionId: "pending_oauth_gmail",
      status: "pending",
    },
    {
      companyId: MIRA_COMPANY_ID,
      userId: ANITA_AUTH_UID,
      appName: "stripe",
      composioConnectionId: "pending_oauth_stripe",
      status: "pending",
    },
  ]);
  console.log("[seed-mira-labs] Composio connection placeholders inserted.");

  // ── TD-2: Pre-seed daily brief (topThreeActions reference real approval UUIDs) ─
  // a3 = Acme Retail proposal approval (Theo-generated)
  // a4 = Bake House invoice reminder approval (Iris-generated)
  // Both were inserted above in the approvals batch and have deterministic DB-assigned UUIDs.
  await seedMiraLabsDailyBrief(db, MIRA_COMPANY_ID, a3!.id, a4!.id);

  // ── Council condition #4 assertion ──────────────────────────────────────────
  // Acceptance criterion: zero instance_api_keys rows seeded.
  // (No insert of instance_api_keys anywhere in this script — verified by grep.)

  // ── Final output ─────────────────────────────────────────────────────────────
  console.log(`
✅ Mira Labs seed complete.
   Sign in at: https://founderos.fly.dev
   Email: ${ANITA_EMAIL}
   Password: ${ANITA_PASSWORD}  ← only visible if you created the user via Admin API
   Company ID: ${MIRA_COMPANY_ID}
   Mirror upsert: ✅ via runPostSignupBootstrap (ANITA_AUTH_UID=${ANITA_AUTH_UID})
   Inbox items: ${approvalCount}
   Daily brief: ✅ pre-seeded for today (Acme Retail + Bake House approvalIds wired)
   Agents: Maya (anthropic_api/claude-opus-4-6), Theo (openai_api/gpt-4.1-mini), Iris (anthropic_api/claude-sonnet-4-6)
   Composio: 3 connections pending OAuth (Slack, Gmail, Stripe)

Next steps (docs/ops/mira-labs-wake-up.md):
   1. Sign in with the credentials above.
   2. Go to Settings → Providers → enter Anthropic + OpenAI API keys.
   3. Go to Settings → Integrations → connect Slack, Gmail, Stripe.
   4. Trigger first agent runs from the Agents page.
`);

  console.log(
    "Mira Labs seeded. Sign in as bajajvinamr+anita@gmail.com / MiraLabs2026!. Complete OAuth for Slack/Gmail/Stripe on wake-up.",
  );
}

// ─── Run ──────────────────────────────────────────────────────────────────────

seedMiraLabs().catch((err) => {
  console.error("[seed-mira-labs] Fatal error:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
