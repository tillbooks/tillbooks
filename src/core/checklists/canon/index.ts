/**
 * The checklist template registry: shipped data read by G22's verbs and by the MCP prompt list.
 * Adding a template is adding a row to `CHECKLIST_TEMPLATES`; nothing in `runs.ts` switches on an id.
 */

import type { ChecklistTemplate } from '../types.js';
import { VAT_PERIOD_TEMPLATE } from './vatPeriod.js';

export { VAT_PERIOD_TEMPLATE, VAT_PERIOD_TEMPLATE_ID } from './vatPeriod.js';

export const CHECKLIST_TEMPLATES: readonly ChecklistTemplate[] = [VAT_PERIOD_TEMPLATE];

const BY_ID: ReadonlyMap<string, ChecklistTemplate> = new Map(CHECKLIST_TEMPLATES.map((t) => [t.templateId, t]));

/** Every shipped template id, for a message that names them. */
export const CHECKLIST_TEMPLATE_IDS: readonly string[] = CHECKLIST_TEMPLATES.map((t) => t.templateId);

/** The template for an id, or undefined when it is not a shipped template. */
export function checklistTemplate(templateId: unknown): ChecklistTemplate | undefined {
  return typeof templateId === 'string' ? BY_ID.get(templateId) : undefined;
}

/** The picker view: id, kind, label, description, period kind, item count. Describes the software. */
export function listChecklistTemplates(): Array<{
  templateId: string;
  kind: string;
  label: string;
  description: string;
  periodKind: string;
  itemCount: number;
}> {
  return CHECKLIST_TEMPLATES.map((t) => ({
    templateId: t.templateId,
    kind: t.kind,
    label: t.label,
    description: t.description,
    periodKind: t.periodKind,
    itemCount: t.items.length,
  }));
}
