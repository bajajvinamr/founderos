# Seed-demo runbook

## What it is

`packages/db/src/seed-demo*.ts` is a family of scripts that insert
demo-only company data into a database for development, screenshots,
sales demos, and integration testing. It is **NEVER** to be run against
a production tenant or any database that holds real customer data.

## Why the env gate exists (P0 audit finding #5, 2026-05-09)

Before this hardening, the seeders inserted three real-named portfolio
companies (`agnost.ai`, `Pred`, `Gravton Labs`) into any database the
script was pointed at. Per CLAUDE.md's "Synthetic data must be
documented and confirmed with client" rule, that was a buyer-trust
hazard — a buyer pointing the script at their tenant would silently get
those names inserted.

The fix has three layers:

1. **Hard env gate.** Each `seed-demo*.ts` refuses to run unless
   `FOUNDEROS_SEED_DEMO=1` is set. No warning, no prompt — exits 1 with
   a refusal message pointing here.
2. **Generic placeholder names.** The seeded companies are now
   `Acme Robotics`, `Beta Labs`, `Demo Corp` — no real-world brands.
3. **`companies.is_demo` boolean column.** Every row inserted by these
   scripts is flagged `is_demo = true`. Real customer rows default to
   `false`. The reset script targets `is_demo = true` rows; analytics
   and metrics queries can filter demo rows out cleanly.

## Safe usage

```bash
FOUNDEROS_SEED_DEMO=1 \
DATABASE_URL=postgres://founderos:founderos@127.0.0.1:54329/founderos \
  pnpm --filter @founderos/db exec tsx src/seed-demo.ts
```

Optional follow-on layers (run in order):

```bash
FOUNDEROS_SEED_DEMO=1 DATABASE_URL=… \
  pnpm --filter @founderos/db exec tsx src/seed-demo-depth.ts

FOUNDEROS_SEED_DEMO=1 DATABASE_URL=… \
  pnpm --filter @founderos/db exec tsx src/seed-demo-narrative.ts
```

## Reset

To wipe demo rows (everything where `is_demo = true`, plus a few legacy
demo names):

```bash
FOUNDEROS_SEED_DEMO=1 SEED_DEMO_RESET_YES=1 \
DATABASE_URL=… \
  pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts
```

The interactive variant (without `SEED_DEMO_RESET_YES=1`) prompts for a
typed confirmation. Both still require `FOUNDEROS_SEED_DEMO=1`.

## Identifying demo rows

```sql
-- All demo companies
SELECT id, name FROM companies WHERE is_demo = true;

-- Excluding demo rows from a real metric
SELECT count(*) FROM companies WHERE is_demo = false;

-- Surface accidentally-demo rows in production (should be zero)
SELECT id, name, created_at FROM companies WHERE is_demo = true;
```

## What if the seed has already shipped to a buyer with the old names?

Run the reset script (it targets the legacy names too) then re-seed with
the placeholder names:

```bash
FOUNDEROS_SEED_DEMO=1 SEED_DEMO_RESET_YES=1 DATABASE_URL=… \
  pnpm --filter @founderos/db exec tsx src/seed-demo-reset.ts

FOUNDEROS_SEED_DEMO=1 DATABASE_URL=… \
  pnpm --filter @founderos/db exec tsx src/seed-demo.ts
```
