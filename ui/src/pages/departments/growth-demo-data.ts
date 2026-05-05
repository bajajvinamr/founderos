/**
 * Growth console preview data — free / trial tier ONLY.
 *
 * Council 2026-05-05 P2 (TC-2 — growth mock exorcism): leaking mock data to
 * paid users on the GrowthConsole was a trust violation. The data on a paid
 * customer's growth surface MUST be either real (live integrations) or an
 * explicit "connect this to see your data" CTA — never fabricated numbers
 * dressed up as their own.
 *
 * This module exposes the same shapes as the live data tabs but with hand-
 * curated demo values. It is imported ONLY by the `<GrowthConsole>` paths
 * that fire when `useIsPaidPlan().isPaid === false`. Importing this in the
 * paid path is a regression — the test in `GrowthConsole.test.tsx` asserts
 * that a paid + integration-less render contains no demo strings.
 */
import { BookOpen, Linkedin, Mail, Search, Users } from "lucide-react";
import type {
  Channel,
  DemoExperiment,
  FunnelStage,
} from "./growth-types.js";

export const DEMO_EXPERIMENTS: DemoExperiment[] = [
  {
    id: "exp-1",
    hypothesis: "Tighten hero to '$10M company with 3 people'",
    channel: "Landing",
    ownerName: "Growth teammate",
    impact: 9,
    confidence: 8,
    ease: 9,
    status: "running",
    expectedLift: "+8% signup rate",
    expectedCacDelta: "-$18 CAC",
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  },
  {
    id: "exp-2",
    hypothesis: "Add pricing anchor — highlight $799 solo tier",
    channel: "Landing",
    ownerName: "Growth teammate",
    impact: 8,
    confidence: 6,
    ease: 9,
    status: "analyzing",
    expectedLift: "+5% trial starts",
    expectedCacDelta: "-$9 CAC",
    updatedAt: new Date(Date.now() - 18 * 60 * 60 * 1000),
  },
  {
    id: "exp-3",
    hypothesis: "LinkedIn outbound to YC founders",
    channel: "LinkedIn",
    ownerName: "Growth teammate",
    impact: 8,
    confidence: 7,
    ease: 6,
    status: "running",
    expectedLift: "+12 demos/mo",
    expectedCacDelta: "-$40 CAC",
    updatedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
  },
  {
    id: "exp-4",
    hypothesis: "Founder-led weekly newsletter",
    channel: "Email",
    ownerName: "Growth teammate",
    impact: 9,
    confidence: 6,
    ease: 5,
    status: "idea",
    expectedLift: "+3% signup rate",
    expectedCacDelta: "$0 CAC",
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  },
  {
    id: "exp-5",
    hypothesis: "Refer-a-founder program (+3 mo scale tier)",
    channel: "Referral",
    ownerName: "Growth teammate",
    impact: 7,
    confidence: 8,
    ease: 4,
    status: "idea",
    expectedLift: "+15% new signups",
    expectedCacDelta: "-$60 CAC",
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
  },
  {
    id: "exp-6",
    hypothesis: "Google Ads on 'AI executive team'",
    channel: "Paid search",
    ownerName: "Growth teammate",
    impact: 6,
    confidence: 5,
    ease: 8,
    status: "killed",
    expectedLift: "+8 signups/mo",
    expectedCacDelta: "+$42 CAC",
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    note: "CAC too high",
  },
];

export const DEMO_CHANNELS: Channel[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: Linkedin,
    signupsThisMonth: 42,
    spendDollars: 0,
    cac: 0,
    deltaPercent: 18,
    trend: "up",
    sparkline: [30, 40, 35, 55, 60, 70, 85],
  },
  {
    id: "content",
    name: "Content / SEO",
    icon: BookOpen,
    signupsThisMonth: 28,
    spendDollars: 0,
    cac: 0,
    deltaPercent: 4,
    trend: "up",
    sparkline: [50, 48, 55, 52, 57, 60, 62],
  },
  {
    id: "referral",
    name: "Referral",
    icon: Users,
    signupsThisMonth: 12,
    spendDollars: 0,
    cac: null,
    deltaPercent: 0,
    trend: "flat",
    sparkline: [20, 15, 18, 22, 16, 19, 20],
  },
  {
    id: "outbound",
    name: "Outbound email",
    icon: Mail,
    signupsThisMonth: 6,
    spendDollars: 8,
    cac: 1.33,
    deltaPercent: -22,
    trend: "down",
    sparkline: [40, 35, 30, 28, 25, 20, 18],
  },
  {
    id: "paid",
    name: "Paid search",
    icon: Search,
    signupsThisMonth: 3,
    spendDollars: 180,
    cac: 60,
    deltaPercent: -70,
    trend: "down",
    sparkline: [80, 60, 45, 30, 20, 10, 5],
  },
];

export const DEMO_FUNNEL: FunnelStage[] = [
  { label: "Traffic", count: 12400 },
  { label: "Signup", count: 348 },
  { label: "Activation", count: 92 },
  { label: "Trial", count: 41 },
  { label: "Paid", count: 7 },
];
