/**
 * The checklist template registry: shipped data read by G22's verbs and by the MCP prompt list.
 * Adding a template is adding a row to `SHIPPED`; nothing in `runs.ts` switches on an id.
 *
 * The `test_kinds` fixture (leg 2, spec §10.13) joins the list ONLY while `NODE_ENV=test`, read at
 * call time rather than at import so a suite that sets the variable before its dynamic import sees
 * it and a generator or a served process never does. `node --test` does not set the variable itself
 * (measured 2026-09-09), so the kinds suite sets it explicitly.
 */

import type { ChecklistTemplate } from '../types.js';
import { VAT_PERIOD_TEMPLATE } from './vatPeriod.js';
import { MONTH_CLOSE_TEMPLATE } from './monthClose.js';
import { YEAR_CLOSE_TEMPLATE } from './yearClose.js';
import { TEST_KINDS_TEMPLATE, TEST_KINDS_TEMPLATE_ID } from './testKinds.js';

export { VAT_PERIOD_TEMPLATE, VAT_PERIOD_TEMPLATE_ID } from './vatPeriod.js';
export { MONTH_CLOSE_TEMPLATE, MONTH_CLOSE_TEMPLATE_ID } from './monthClose.js';
export {
  YEAR_CLOSE_TEMPLATE,
  YEAR_CLOSE_TEMPLATE_ID,
  YEAR_CLOSE_BLOCK_VALIDATIONS,
  YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF,
  GMBH_OR_AG,
  VAT_REGISTERED,
  LEGAL_FORM_OPTIONS,
  VAT_METHOD_OPTIONS,
  YES_NO,
} from './yearClose.js';
export { TEST_KINDS_TEMPLATE, TEST_KINDS_TEMPLATE_ID } from './testKinds.js';

/** Picker order: the MWST-Periode (D127), then the two close templates (D129) in period order. */
const SHIPPED: readonly ChecklistTemplate[] = [VAT_PERIOD_TEMPLATE, MONTH_CLOSE_TEMPLATE, YEAR_CLOSE_TEMPLATE];

/** Is the test-only fixture template registered right now? */
export function testFixturesEnabled(): boolean {
  return process.env.NODE_ENV === 'test';
}

/** Every registered template, in picker order: the shipped ones, plus the fixture under test. */
export function checklistTemplates(): readonly ChecklistTemplate[] {
  return testFixturesEnabled() ? [...SHIPPED, TEST_KINDS_TEMPLATE] : SHIPPED;
}

/**
 * The SHIPPED templates as a constant, for callers that enumerate product data (the prompt list, the
 * generated documents). The fixture is deliberately absent here: use `checklistTemplates()` for the
 * live registry.
 */
export const CHECKLIST_TEMPLATES: readonly ChecklistTemplate[] = SHIPPED;

/** Every registered template id, for a message that names them. */
export const CHECKLIST_TEMPLATE_IDS: readonly string[] = SHIPPED.map((t) => t.templateId);

/** The template for an id, or undefined when it is not a registered template. */
export function checklistTemplate(templateId: unknown): ChecklistTemplate | undefined {
  if (typeof templateId !== 'string') return undefined;
  if (templateId === TEST_KINDS_TEMPLATE_ID) return testFixturesEnabled() ? TEST_KINDS_TEMPLATE : undefined;
  return SHIPPED.find((t) => t.templateId === templateId);
}

/** The picker view: id, kind, label, description, period kind, anchor, item count. Describes the software. */
export function listChecklistTemplates(): Array<{
  templateId: string;
  kind: string;
  label: string;
  description: string;
  periodKind: string;
  anchor: string;
  itemCount: number;
}> {
  return checklistTemplates().map((t) => ({
    templateId: t.templateId,
    kind: t.kind,
    label: t.label,
    description: t.description,
    periodKind: t.periodKind,
    anchor: t.anchor,
    itemCount: t.items.length,
  }));
}
