#!/usr/bin/env tsx
/**
 * Seed script — Khushi Srivastav · Co.
 *
 * Creates the full company + 22 department agents + 1 cross-cutting provocateur
 * in a single atomic transaction via FounderOS's template spawn endpoint.
 *
 * Run:
 *   pnpm exec tsx scripts/seed-khushi-co.ts
 *
 * Requires FounderOS running locally (default: http://127.0.0.1:3101).
 * In local_trusted mode, localhost requests carry implicit board actor
 * — no auth header needed.
 */

import { khushiSrivastavCo } from "./khushi-template.js";

const BASE = process.env.FOUNDEROS_URL ?? "http://127.0.0.1:3101";

async function httpJson(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${res.statusText}\n${JSON.stringify(
        json,
        null,
        2,
      )}`,
    );
  }
  return json as Record<string, unknown>;
}

async function health() {
  const h = await httpJson("GET", "/api/health");
  console.log("✓ health:", JSON.stringify(h));
}

async function spawnCompany() {
  console.log(
    `→ Spawning company: ${khushiSrivastavCo.name} (${khushiSrivastavCo.agents.length} agents + 3 goals + 4 projects)`,
  );

  const result = await httpJson("POST", "/api/templates/spawn", {
    inlineTemplate: khushiSrivastavCo,
    companyName: khushiSrivastavCo.name,
    providerStrategy: "anthropic_first",
  });

  console.log("✓ spawn result:");
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function seedMemory(companyId: string) {
  console.log(`→ Seeding founder notes for company ${companyId}`);

  const notes = [
    {
      kind: "founder_note",
      title: "North-star strategy — read this first",
      body: "Full strategy at ~/Projects/khushi-site/docs/playbook.md. Phase 1 (now through July 2026): foundation. Deep essays, ADI Q2 drop, first BoF/FT/WSJ citation. Never compete with BoF directly — route around them. Become the named source they cite.",
      topic: "strategy",
      pinned: true,
      source: "manual",
    },
    {
      kind: "founder_note",
      title: "Voice rules — non-negotiable",
      body: "Read ~/Projects/khushi-ops/voice-profile.md before any writing agent drafts. No em dashes, British English, no rule-of-three, no AI-slop vocab, specific over abstract. Christian enforces on every publish.",
      topic: "voice",
      pinned: true,
      source: "manual",
    },
    {
      kind: "founder_note",
      title: "Sources to crawl",
      body: "80+ sources in ~/Projects/khushi-ops/sources.json across 5 pillars: luxury, fashion, art, music, design + India/GCC regional. Rafi crawls daily. Emily tags value/face-saving/noise/people-moving/letter.",
      topic: "research",
      pinned: true,
      source: "manual",
    },
    {
      kind: "founder_note",
      title: "The three-bucket frame",
      body: "Every brand move Emily tags into one of: VALUE (genuine long-term equity), FACE-SAVING (reactive damage-control), NOISE (PR without substance). Khushi's yearly thesis essay will be built from 12 months of these tags.",
      topic: "framework",
      pinned: true,
      source: "manual",
    },
    {
      kind: "founder_note",
      title: "Model routing",
      body: "Opus 4.7 for planning/judgment/creative (9 agents: Andy, Christian, Nigel, Betty, Willow, Nate, Ivy, August, Clara). Sonnet 4.6 for execution (Dorothea, Jocelyn, Richard, Peter, Irv, Mirrorball). Haiku 4.5 for mechanical (James, Emily, Marjorie, Karma, Serena, Doug, Lily, Stephen).",
      topic: "infra",
      pinned: false,
      source: "manual",
    },
  ];

  const companyIdStr = String(companyId);
  for (const note of notes) {
    try {
      await httpJson("POST", `/api/companies/${companyIdStr}/memory`, note);
      console.log(`  ✓ memory: ${note.title}`);
    } catch (err) {
      console.warn(`  ! memory failed: ${note.title} — ${(err as Error).message}`);
    }
  }
}

async function main() {
  console.log(`\nKhushi Srivastav · Co. — Seed Script`);
  console.log(`FounderOS: ${BASE}\n`);

  try {
    await health();
  } catch (err) {
    console.error(
      `✗ FounderOS not reachable at ${BASE}. Start it with: cd ~/Projects/founderos && pnpm dev`,
    );
    throw err;
  }

  let spawn: Record<string, unknown>;
  try {
    spawn = await spawnCompany();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      console.log("ℹ company already exists — skipping spawn");
      return;
    }
    throw err;
  }

  const companyId =
    (spawn.companyId as string | undefined) ??
    (spawn.id as string | undefined) ??
    ((spawn.company as { id?: string } | undefined)?.id);

  if (companyId) {
    await seedMemory(companyId);
  } else {
    console.warn(
      "! spawn response did not include a companyId — skipping memory seed",
    );
  }

  console.log(`\n✓ Done. Open http://127.0.0.1:3101 to see the company.\n`);
}

main().catch((err) => {
  console.error("\n✗ Seed failed:\n", err);
  process.exit(1);
});
