/**
 * G22 Checklisten (D127): recurring checklists as shipped product data, the MWST-Periode first.
 *
 * A template instantiates into a run with dated, owned, evidenced items; the state is derived on
 * every read (live checks, hash-bound verb evidence, append-only sign-offs); eight `checklist_*`
 * verbs, one MCP prompt per template and the G15 `checklist_items_due` provider all read the ONE
 * derivation in `runs.ts`. Nothing here posts, and no table carries a `_rappen` column.
 */

export {
  CHECKLIST_CHECK_KEYS,
  CHECKLIST_EVIDENCE_KINDS,
  CHECKLIST_SIGNOFF_KINDS,
  prerequisitesOf,
} from './types.js';
export type {
  RunbookPhase,
  RunbookOwnerKind,
  DeadlineRule,
  RunbookTemplateItemBase,
  RunbookTemplateItem,
  RunbookTemplate,
  ChecklistCheckKey,
  ChecklistEvidenceKind,
  ChecklistSignoffKind,
  ChecklistPeriodKind,
  ChecklistTemplateItem,
  ChecklistTemplate,
} from './types.js';
export {
  CHECKLIST_TEMPLATES,
  CHECKLIST_TEMPLATE_IDS,
  VAT_PERIOD_TEMPLATE,
  VAT_PERIOD_TEMPLATE_ID,
  checklistTemplate,
  listChecklistTemplates,
} from './canon/index.js';
export { CHECKLISTS_SCHEMA_SQL } from './schema.js';
export { VAT_DEADLINE_DAYS, addDays, resolveDueDates } from './deadlines.js';
export { evaluateCheck, liveReturnOf } from './checks.js';
export type { CheckResult, CheckPeriod, LiveReturn } from './checks.js';
export { returnHashOf } from './hash.js';
export {
  CHECKLIST_RUN_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  deriveRun,
  openRunRows,
  runRowFor,
  checklistStart,
  checklistGet,
  checklistList,
  checklistItemComplete,
  checklistItemSkip,
  checklistItemReopen,
  checklistAbandon,
} from './runs.js';
export type {
  ChecklistRunStatus,
  ChecklistItemStatus,
  ChecklistActorKind,
  ChecklistRunView,
  ChecklistItemView,
  ChecklistSignoffView,
  ChecklistStartInput,
  ChecklistListInput,
  ChecklistItemCompleteInput,
  ChecklistItemSkipInput,
  ChecklistItemReopenInput,
  ChecklistAbandonInput,
} from './runs.js';
export {
  promptNameFor,
  CHECKLIST_PROMPT_ARGUMENTS,
  listChecklistPrompts,
  templateForPrompt,
  pickChecklistPeriod,
  renderChecklistPromptText,
  renderChecklistPromptRefusal,
  renderChecklistPrompt,
} from './prompt.js';
export type { PromptPeriod, RenderPromptInput } from './prompt.js';
export { checklistItemsDueProvider, CHECKLIST_DUE_WINDOW_DAYS } from './attentionProvider.js';
