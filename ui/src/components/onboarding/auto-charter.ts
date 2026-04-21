/**
 * Deterministic charter + first-decision generator.
 *
 * No LLM at onboarding time. The actual agents will run their real prompts
 * server-side on first heartbeat — this function exists only to make step 5
 * ("Meet your team") feel like the CoS already understands what the founder
 * is building. Every output must change when inputs change.
 */

import {
  AGENT_SLOTS,
  BOTTLENECK_LABELS,
  type AgentCharter,
  type AgentCharterMap,
  type AgentSlot,
  type Bottleneck,
  type FirstDecisionCard,
  type TeamShape,
} from "./onboarding-types.js";

const AGENT_DEFAULTS: Record<
  AgentSlot,
  { name: string; title: string; avatar: string }
> = {
  cos: { name: "Chief of Staff", title: "CoS", avatar: "CS" },
  growth: { name: "Head of Growth", title: "Growth", avatar: "HG" },
  content: { name: "Head of Content", title: "Content", avatar: "HC" },
  finance: { name: "Head of Finance", title: "Finance", avatar: "HF" },
};

function summariseVision(vision: string): string {
  const trimmed = vision.trim().replace(/\s+/g, " ");
  if (!trimmed) return "what you're building";
  // Keep a short inline reference that fits into a 2-sentence charter.
  const clipped = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return clipped;
}

function formatBottleneckList(bottlenecks: Bottleneck[]): string {
  if (bottlenecks.length === 0) return "whatever you point at";
  if (bottlenecks.length === 1) return BOTTLENECK_LABELS[bottlenecks[0]!];
  const labels = bottlenecks.map((b) => BOTTLENECK_LABELS[b]);
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function teamVoice(team: TeamShape): string {
  if (team === "solo") return "You're running solo";
  if (team === "cofounder") return "You and your cofounder are steering";
  return "You and your small team are steering";
}

function cosCharter(
  vision: string,
  bottlenecks: Bottleneck[],
  team: TeamShape,
): AgentCharter {
  const summary = summariseVision(vision);
  const voice = teamVoice(team);
  const focus = formatBottleneckList(bottlenecks);
  return {
    slot: "cos",
    ...AGENT_DEFAULTS.cos,
    charter: `${voice}, so I'm the air-traffic controller for ${summary}. I own Decision Inbox, Weekly Wrap, and turn your half-thoughts on ${focus} into owned work.`,
    firstPriority: `Run the first weekly review — what moved, what stalled, what blocks ${focus}.`,
  };
}

function growthCharter(
  vision: string,
  bottlenecks: Bottleneck[],
): AgentCharter {
  const summary = summariseVision(vision);
  const isGrowth = bottlenecks.includes("growth");
  const isPmf = bottlenecks.includes("pmf");
  const isHiring = bottlenecks.includes("hiring");
  const isFundraising = bottlenecks.includes("fundraising");

  let charter: string;
  let firstPriority: string;

  if (isPmf) {
    charter = `I hunt signal for ${summary}. Customer interviews, landing-page tests, and cold outbound run through me — the goal is unambiguous pull before any paid spend.`;
    firstPriority =
      "Book 5 customer interviews this week and write up what actually hurts.";
  } else if (isGrowth) {
    charter = `I run the acquisition loop for ${summary}. I own the funnel from first touch to activated user and ship experiments weekly against a single North-Star.`;
    firstPriority =
      "Pick one channel, ship a landing-page A/B test, report CAC + activation by Friday.";
  } else if (isFundraising) {
    charter = `I warm the investor pipeline around ${summary}. I source intros, draft updates, and keep the funnel from angels to Series A honest.`;
    firstPriority =
      "Build a 30-investor list tiered by fit, draft a 4-paragraph update.";
  } else if (isHiring) {
    charter = `I grow the top of funnel for ${summary} while you hire. Content, referral, and outbound stay cheap and measurable until the first growth hire lands.`;
    firstPriority =
      "Draft 3 low-cost channel experiments we can run without a growth hire.";
  } else {
    charter = `I scout demand for ${summary}. Channels, experiments, and weekly reports on what's cheap to try and what's working.`;
    firstPriority =
      "Map the 5 most plausible acquisition channels and propose one to try first.";
  }

  return {
    slot: "growth",
    ...AGENT_DEFAULTS.growth,
    charter,
    firstPriority,
  };
}

function contentCharter(
  vision: string,
  bottlenecks: Bottleneck[],
): AgentCharter {
  const summary = summariseVision(vision);
  const isContent = bottlenecks.includes("content");
  const isGrowth = bottlenecks.includes("growth");
  const isPmf = bottlenecks.includes("pmf");

  let charter: string;
  let firstPriority: string;

  if (isContent) {
    charter = `I am the writing-room for ${summary}. Editorial calendar, long-form posts, landing-page copy, and founder ghost-writing — all on brand, all shipped weekly.`;
    firstPriority =
      "Draft the first 4-week editorial calendar with one anchor post ready to edit.";
  } else if (isPmf) {
    charter = `I turn raw customer quotes from ${summary} into public writing. Less marketing, more pattern-matching out loud.`;
    firstPriority =
      "Interview notes to a draft 'insight post' by end of week.";
  } else if (isGrowth) {
    charter = `I turn the growth team's tests into narrative. Every experiment ships with a launch post and a post-mortem so the audience compounds.`;
    firstPriority =
      "Write the launch note for the first growth experiment.";
  } else {
    charter = `I build an audience for ${summary}. Consistent shipping beats perfect — 1 anchor post a week plus 3 short-form amplifications.`;
    firstPriority =
      "Ship the first founder-voice post this week.";
  }

  return {
    slot: "content",
    ...AGENT_DEFAULTS.content,
    charter,
    firstPriority,
  };
}

function financeCharter(
  vision: string,
  bottlenecks: Bottleneck[],
): AgentCharter {
  const summary = summariseVision(vision);
  const isFinance = bottlenecks.includes("finance");
  const isFundraising = bottlenecks.includes("fundraising");

  let charter: string;
  let firstPriority: string;

  if (isFinance) {
    charter = `I own the numbers behind ${summary}. Runway, burn, vendor spend, subscription sprawl — a single dashboard the founder can trust.`;
    firstPriority =
      "Categorise the last 90 days of spend and flag the top 3 subscriptions to cut.";
  } else if (isFundraising) {
    charter = `I keep ${summary}'s financial story investor-ready. Monthly update metrics, clean runway math, and scenarios for the next raise.`;
    firstPriority =
      "Build a 12-month runway model with bull / base / bear.";
  } else {
    charter = `I watch the P&L for ${summary}. Runway, burn, and one honest sentence per week on whether we're getting leaner or fatter.`;
    firstPriority =
      "Produce a first weekly finance snapshot.";
  }

  return {
    slot: "finance",
    ...AGENT_DEFAULTS.finance,
    charter,
    firstPriority,
  };
}

export interface BuildCharterInput {
  vision: string;
  bottlenecks: Bottleneck[];
  team: TeamShape;
}

export function buildAutoCharters(input: BuildCharterInput): AgentCharterMap {
  const { vision, bottlenecks, team } = input;
  return {
    cos: cosCharter(vision, bottlenecks, team),
    growth: growthCharter(vision, bottlenecks),
    content: contentCharter(vision, bottlenecks),
    finance: financeCharter(vision, bottlenecks),
  };
}

export function listSlots(): readonly AgentSlot[] {
  return AGENT_SLOTS;
}

/**
 * Seed 3 first-decision cards based on which bottleneck(s) the founder
 * selected. Cards are deterministic templates — the assigned agent turns
 * them into real work on their first heartbeat.
 */
export function buildFirstDecisions(
  bottlenecks: Bottleneck[],
): FirstDecisionCard[] {
  const primary = bottlenecks[0];

  if (primary === "pmf") {
    return [
      {
        id: "pmf_interviews",
        slot: "growth",
        title: "Run a 5-customer interview sprint this week",
        rationale:
          "Five 30-minute calls, one write-up that separates 'would pay' from 'polite nods'. Fastest way to stop guessing at PMF.",
      },
      {
        id: "pmf_landing",
        slot: "growth",
        title: "Launch a landing-page A/B test",
        rationale:
          "Two headlines, one offer, a signup form — see which promise actually converts before building more.",
      },
      {
        id: "pmf_insights_post",
        slot: "content",
        title: "Publish an 'insight post' from your interviews",
        rationale:
          "Ghost-written in your voice; turns raw interview patterns into a public artefact that pulls more of the right users in.",
      },
    ];
  }

  if (primary === "growth") {
    return [
      {
        id: "growth_channel_test",
        slot: "growth",
        title: "Pick one channel and ship an experiment by Friday",
        rationale:
          "One channel, one offer, one week. Report CAC + activation. Kills analysis-paralysis at the top of the funnel.",
      },
      {
        id: "growth_cold_email",
        slot: "growth",
        title: "Draft a cold-email campaign to 50 ICP founders",
        rationale:
          "Hand-written, not templated. Measures whether the ICP recognises the problem before you spend on ads.",
      },
      {
        id: "growth_launch_post",
        slot: "content",
        title: "Write a launch post paired to the first growth experiment",
        rationale:
          "Every experiment ships with a story. Compounds attention even when the test itself is a miss.",
      },
    ];
  }

  if (primary === "hiring") {
    return [
      {
        id: "hiring_jd",
        slot: "cos",
        title: "Draft the first founding-engineer JD + scorecard",
        rationale:
          "Before sourcing: what does 'great' look like, why is this role defensible, and which 3 signals disqualify fast.",
      },
      {
        id: "hiring_outreach",
        slot: "growth",
        title: "Compile a 30-candidate warm-intro outreach list",
        rationale:
          "Second-degree connections only. Every message is personal. Converts warm intros into real conversations this week.",
      },
      {
        id: "hiring_announce",
        slot: "content",
        title: "Publish a 'we're hiring' founder post",
        rationale:
          "Lightweight signal that surfaces hidden candidates already following you.",
      },
    ];
  }

  if (primary === "content") {
    return [
      {
        id: "content_calendar",
        slot: "content",
        title: "Ship a 4-week editorial calendar",
        rationale:
          "One anchor post a week plus 3 short-form amplifications — the minimum viable content engine.",
      },
      {
        id: "content_anchor",
        slot: "content",
        title: "Write the first anchor post end-to-end",
        rationale:
          "Founder-voice, 1,200 words, sitting in your inbox ready to edit. No more staring at a blank page on Monday.",
      },
      {
        id: "content_distribution",
        slot: "growth",
        title: "Map a 3-channel distribution plan for the anchor post",
        rationale:
          "Writing is half the job. The Growth lead plans where the post actually lands.",
      },
    ];
  }

  if (primary === "finance") {
    return [
      {
        id: "finance_cleanup",
        slot: "finance",
        title: "Categorise the last 90 days of spend",
        rationale:
          "One clean ledger, clear vendor buckets, and the top 3 line items to cut this week.",
      },
      {
        id: "finance_runway",
        slot: "finance",
        title: "Build a 12-month runway model (bull / base / bear)",
        rationale:
          "Three scenarios, one file, one sentence conclusion per month.",
      },
      {
        id: "finance_weekly",
        slot: "cos",
        title: "Stand up the weekly finance snapshot ritual",
        rationale:
          "Five numbers, every Monday. The CoS makes sure it actually ships.",
      },
    ];
  }

  if (primary === "fundraising") {
    return [
      {
        id: "raise_list",
        slot: "growth",
        title: "Build a 30-investor list, tiered by fit",
        rationale:
          "Stage, thesis, portfolio overlap. Warm-intro path for each. The pipeline before the pitch.",
      },
      {
        id: "raise_update",
        slot: "content",
        title: "Draft a 4-paragraph founder update",
        rationale:
          "Ship monthly to the list — builds consistency and lets angels feel momentum before the formal raise.",
      },
      {
        id: "raise_model",
        slot: "finance",
        title: "Produce the runway + use-of-funds model",
        rationale:
          "Numbers tight before any partner meeting. Bull / base / bear, plus what each tranche actually buys.",
      },
    ];
  }

  if (primary === "ops") {
    return [
      {
        id: "ops_slas",
        slot: "cos",
        title: "Write the first ops SLAs + on-call owners",
        rationale:
          "Who responds, how fast, with which playbook. Stops the founder being the default on-call.",
      },
      {
        id: "ops_vendors",
        slot: "finance",
        title: "Audit vendor subscriptions, cut the bottom 20%",
        rationale:
          "Fastest margin win. Lists every recurring line item and flags the fat.",
      },
      {
        id: "ops_playbook",
        slot: "content",
        title: "Turn the top 3 repeated tasks into public playbooks",
        rationale:
          "Documentation doubles as recruiting signal. Publish them as they land.",
      },
    ];
  }

  // Default — no bottleneck picked yet.
  return [
    {
      id: "default_interviews",
      slot: "growth",
      title: "Run a 5-customer interview sprint this week",
      rationale:
        "Signal first, everything else second. The fastest way to focus the next 30 days.",
    },
    {
      id: "default_landing",
      slot: "content",
      title: "Draft a one-page narrative for what you're building",
      rationale:
        "Writes down the story so the whole AI team speaks with one voice.",
    },
    {
      id: "default_runway",
      slot: "finance",
      title: "Produce the first runway snapshot",
      rationale:
        "Five numbers, updated weekly. Forces a shared reality on spend and pace.",
    },
  ];
}
