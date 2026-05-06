/**
 * Shared shapes between GrowthConsole.tsx and growth-demo-data.ts. Lifted out
 * so the demo data module can stay focused on values and the console can stay
 * focused on rendering and live data wiring.
 */
import type { ElementType } from "react";

export type ExperimentStatus =
  | "idea"
  | "running"
  | "analyzing"
  | "shipped"
  | "killed";

export interface Experiment {
  id: string;
  hypothesis: string;
  channel: string;
  ownerName: string;
  impact: number;
  confidence: number;
  ease: number;
  status: ExperimentStatus;
  expectedLift: string;
  expectedCacDelta: string;
  updatedAt: Date;
  note?: string;
}

/**
 * `DemoExperiment` is structurally identical to `Experiment` but exists as a
 * distinct named type so callers reading types can see at a glance whether a
 * value originated from real data or the demo module. The runtime shape is
 * the same — paid renders never reach demo data, so the divergence is purely
 * documentary.
 */
export type DemoExperiment = Experiment;

export interface Channel {
  id: string;
  name: string;
  icon: ElementType;
  signupsThisMonth: number;
  spendDollars: number;
  cac: number | null;
  deltaPercent: number;
  trend: "up" | "down" | "flat";
  /** 7 values, 0–100 relative heights for the sparkline. */
  sparkline: number[];
}

export interface FunnelStage {
  label: string;
  count: number;
}
