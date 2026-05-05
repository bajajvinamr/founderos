# ARCHIVE — Self-Serve Provisioning Roadmap (superseded 2026-05-05)

_Drafted 2026-05-04. Superseded 2026-05-05 by DoubtBuddy 6-sprint roadmap. Kept as v2 reference for the day FounderOS is sold to design partners and we want managed-instance SaaS lifecycle automation._

## Why this was superseded

The 9-phase self-serve provisioning roadmap below was written before re-reading the DoubtBuddy buyer scope. The $4k buyer (whose customer is FounderOS, who will then resell as SaaS) bought:

- **An AI Company OS** — Chief of Staff agent + Growth/Content/CRM/Finance/Ops departments + KPI right rail + workflow approvals + scenario modeling
- **A 6-week MVP build** to reach 20-50 design partners
- **Key metric: incremental MRR lift per customer within 30 days**

NOT:
- Per-customer Fly app provisioning lifecycle (Polar.sh model)
- Marketing site at `founderos.com`
- Stripe Checkout → auto-provision → wildcard-DNS pipeline

The provisioning automation IS valuable — but it's **what the buyer does to resell** FounderOS to their own SaaS customers, not what FounderOS itself is. It belongs at v2 once the product exists and design partners exist to be onboarded.

## What was archived (not deleted)

The original `PROJECT.md`, `ROADMAP.md`, `PHASES/PHASE-1-manual-cutover.md`, `PHASES/PHASE-2-provisioning-service.md` are consolidated below for reference.

---

## Original PROJECT.md

# FounderOS — Self-Serve Provisioning ("Pay → Provision")

_Started 2026-05-04. Authorized by Vinamr to run autonomously until production-ready._

### North star

A founder lands on `founderos.com`, clicks "Start trial", pays via Stripe Checkout (or starts a 14-day trial), and within ~2 minutes is signed in to their own fully provisioned FounderOS instance at `<slug>.founderos.app`. **Fully self-serve. Zero human in the loop.** 100 customers = 100 Fly apps, scale-to-zero idle cost.

This is the Polar.sh / Plane.so / Cal.com Cloud model: managed-instance SaaS where the customer's data and app run in their own dedicated container, but provisioning, billing, and lifecycle are fully automated from the marketing site.

### Why this shape (not multi-tenant)

- Buyer wedge: founders want a self-contained "control plane for their startup" — not a row in someone else's multi-tenant DB. Per-instance isolation is the value prop, not the cost.
- Schema: `companies` table looks multi-tenant but is per-instance — the "company" in the schema = the founder's actual startup, and a founder runs exactly one.
- Existing infra is already shaped for this: `scripts/fly-provision.sh` exists today (manual CLI), `fly.toml` is per-app, `auto_stop_machines = "stop"` makes 100 idle instances ≈ free.

### Success criteria (production-ready definition)

1. Visit `founderos.com` → click "Start trial" → Stripe Checkout → success
2. Land on "provisioning your instance…" page that polls every 2-3s
3. Within ~2 min, redirect to `<their-slug>.founderos.app/onboarding`
4. Complete onboarding → run a heartbeat → see Claude output → receive welcome email
5. Operator can see per-customer Fly cost; cancel triggers 7-day grace → auto-teardown

---

## Original 9-Phase ROADMAP

| # | Phase | Effort | Depends on |
|---|---|---|---|
| 1 | Manual cutover smoke test | 1d | – |
| 2 | Provisioning service (HTTP API) | 2-3d | P1 |
| 3 | Stripe Checkout → Provision webhook | 1-2d | P2 |
| 4 | Marketing site at `founderos.com` | 2-3d | P3 |
| 5 | Wildcard DNS + per-instance domains | 1d | P4 |
| 6 | Customer dashboard | 2-3d | P5 |
| 7 | De-provisioning on cancel | 1d | P6 |
| 8 | Fly cost telemetry + margin alerts | 1d | P7 |
| 9 | ADR-012 + production cutover | 1d | P8 |

**Critical path**: P1 → P5 = ~8 days = MVP self-serve loop.

### Cross-cutting decisions

| Decision | Options |
|---|---|
| Marketing site host | Vercel · Cloudflare Pages · Fly static |
| `founderos.app` domain | Already owned? · Need to register? |
| Postgres model per instance | Fly MPG attach · Shared cluster + per-customer DB · Supabase per project |
| Stripe live keys | When ready in Phase 9 |
| Trial length | 7d · 14d · 30d |
| Pricing tier(s) | Single $99/mo · Tiered (free trial → pro) · Usage-based |

---

## Phase 1 detailed plan (preserved)

**Goal**: Run `scripts/fly-provision.sh` end-to-end against a fresh `founderos-smoke` slug. Walk full lifecycle, capture every manual step into runbook.

**Success criteria**: A new Fly app `founderos-smoke` exists, deployed, healthy, scale-to-zero working. A test user can sign up, become `instance_admin` automatically, complete onboarding, run a heartbeat. Runbook at `docs/ops/manual-provision-runbook.md`.

**Key tasks**:
- Document `scripts/fly-provision.sh` current contract
- Provision fresh smoke instance, capture timing + inputs + outputs
- Walk founder onboarding lifecycle in fresh browser
- Capture recovery paths (admin lockout, missed webhook, app stopped, migration failed)
- Write runbook with structure: when-to-use / pre-flight / step 1-4 / recovery / gap list

**Pre-flight decisions** (need user input):
- Confirm `founderos.app` domain ownership
- Confirm Fly account billing + budget alerts
- Confirm Postgres provisioning path (per-customer cluster vs shared cluster + per-customer DB vs Supabase per project)

---

## Phase 2 detailed plan (preserved)

**Goal**: Programmatic HTTP API that takes a Stripe subscription id + customer email and provisions a fresh FounderOS instance idempotently.

**Success criteria**: `POST /provision` returns `{ jobId, status: "queued" }`. Background worker spins up Fly app + Postgres + secrets within ~2 min. `GET /provision/:jobId/status` returns instance URL when ready. Idempotent on Stripe subscription id. Tests cover happy path + failure modes.

**Decisions to lock first**:
- D2.1 Where does the service live? (a) `services/provisioning/` new package, (b) routes in existing `server/`, (c) Vercel/Cloudflare Function. **Recommended**: B for v1.
- D2.2 Postgres model. **Recommended**: B (shared cluster + per-customer DB) for v1.
- D2.3 Slug generation. **Recommended**: auto-generate from email + random suffix.

**Schema** (control plane):
```sql
CREATE TABLE provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_subscription_id text UNIQUE NOT NULL,
  stripe_customer_id text NOT NULL,
  customer_email text NOT NULL,
  slug text UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','provisioning','ready','failed','pending_teardown','destroyed')),
  fly_app_name text,
  postgres_db_name text,
  master_key_id text,
  instance_url text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  grace_until timestamptz
);
```

**Tasks**:
- 2.1 — Migration for `provisioning_jobs`
- 2.2 — Fly Machines API client (`server/src/services/fly-client.ts`)
- 2.3 — Postgres provisioner (per D2.2)
- 2.4 — Provisioning service core (idempotent worker, BullMQ or `setImmediate` for v1)
- 2.5 — `/api/provision/:jobId/status` polling endpoint
- 2.6 — Unit + integration + idempotency + failure-rollback tests

---

## When to revive this archive

When ALL of:
1. DoubtBuddy 6-sprint MVP has shipped and survived design-partner usage
2. Buyer is ready to begin reselling to their own SaaS customers
3. There's a clear demand signal for managed-instance lifecycle (vs the buyer running it themselves)
4. The architecture has been re-evaluated against multi-tenancy alternatives (single-deploy with strict workspace isolation might be cheaper than per-customer Fly apps at 100+ scale)

The archive is mechanically correct for what it intended to do — Fly per-customer-app + scale-to-zero is a valid pattern (Cal.com, Plane, Polar, Supabase Spawn all use shape-of-this). The misalignment was scope, not technology.
