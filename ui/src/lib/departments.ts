import {
  Compass,
  TrendingUp,
  PenTool,
  Users,
  DollarSign,
  Code2,
  Settings2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentRole, Agent } from "@founderos/shared";

export interface Department {
  id: string;
  label: string;
  sublabel: string;
  icon: LucideIcon;
  roles: AgentRole[];
}

export const DEPARTMENTS: Department[] = [
  {
    id: "chief-of-staff",
    label: "Chief of Staff",
    sublabel: "Priorities, brief, capital allocation",
    icon: Compass,
    roles: ["ceo"],
  },
  {
    id: "growth",
    label: "Growth",
    sublabel: "Acquisition, experiments, channels",
    icon: TrendingUp,
    roles: ["cmo", "pm"],
  },
  {
    id: "content",
    label: "Content Studio",
    sublabel: "Research, drafts, distribution, attribution",
    icon: PenTool,
    roles: ["designer", "researcher"],
  },
  {
    id: "crm",
    label: "CRM & Lifecycle",
    sublabel: "Onboarding, activation, churn, upsell",
    icon: Users,
    roles: [],
  },
  {
    id: "finance",
    label: "Finance",
    sublabel: "Revenue, pricing, runway, burn",
    icon: DollarSign,
    roles: ["cfo"],
  },
  {
    id: "engineering",
    label: "Engineering",
    sublabel: "Product, PRs, reviews, infra",
    icon: Code2,
    roles: ["cto", "engineer", "devops", "qa"],
  },
  {
    id: "ops",
    label: "Operations",
    sublabel: "Workflows, approvals, SOPs",
    icon: Settings2,
    roles: ["general"],
  },
];

export function getDepartmentById(id: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.id === id);
}

export function departmentForRole(role: AgentRole): Department | undefined {
  return DEPARTMENTS.find((d) => (d.roles as AgentRole[]).includes(role));
}

export function agentsInDepartment(departmentId: string, agents: Agent[]): Agent[] {
  const dept = getDepartmentById(departmentId);
  if (!dept) return [];
  if (dept.roles.length === 0) return [];
  return agents.filter((a) => (dept.roles as AgentRole[]).includes(a.role));
}
