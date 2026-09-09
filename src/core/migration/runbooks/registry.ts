/**
 * The runbook template registry accessors: shipped data read by G20's verbs (US-G20.2).
 */

import { RUNBOOK_TEMPLATES } from './canon.js';
import type { RunbookTemplate } from './types.js';

export { RUNBOOK_TEMPLATES } from './canon.js';
export type {
  RunbookTemplate,
  RunbookTemplateItem,
  RunbookPhase,
  RunbookOwnerKind,
  DeadlineRule,
} from './types.js';

const BY_ID: ReadonlyMap<string, RunbookTemplate> = new Map(
  RUNBOOK_TEMPLATES.map((t) => [t.templateId, t]),
);

/** Every shipped template id, for the picker and for a message that names them. */
export const RUNBOOK_TEMPLATE_IDS: readonly string[] = RUNBOOK_TEMPLATES.map((t) => t.templateId);

/** The template for an id, or undefined when it is not a shipped template. */
export function runbookTemplate(templateId: unknown): RunbookTemplate | undefined {
  return typeof templateId === 'string' ? BY_ID.get(templateId) : undefined;
}

/** The picker view: id, label, description, item count. Describes the software, not any workspace. */
export function listRunbookTemplates(): Array<{
  templateId: string;
  label: string;
  description: string;
  itemCount: number;
}> {
  return RUNBOOK_TEMPLATES.map((t) => ({
    templateId: t.templateId,
    label: t.label,
    description: t.description,
    itemCount: t.items.length,
  }));
}
