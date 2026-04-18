import type { CompanyTemplate } from "@founderos/shared";
import { summarizeTemplate } from "@founderos/shared";
import { soloIndieSaasFounder } from "./solo-indie-saas-founder.js";
import { preseedAiLab } from "./preseed-ai-lab.js";
import { bootstrappedB2bSaas } from "./bootstrapped-b2b-saas.js";

/**
 * All built-in FounderOS company templates. New templates go in their own
 * file and are registered here.
 */
export const BUILTIN_TEMPLATES: readonly CompanyTemplate[] = Object.freeze([
  soloIndieSaasFounder,
  preseedAiLab,
  bootstrappedB2bSaas,
]);

const TEMPLATES_BY_ID = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));

export function listTemplates(): readonly CompanyTemplate[] {
  return BUILTIN_TEMPLATES;
}

export function listTemplateSummaries() {
  return BUILTIN_TEMPLATES.map(summarizeTemplate);
}

export function getTemplate(id: string): CompanyTemplate | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}

export { soloIndieSaasFounder, preseedAiLab, bootstrappedB2bSaas };
