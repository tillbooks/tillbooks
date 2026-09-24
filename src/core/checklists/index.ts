/**
 * G22 Checklisten (D127, leg 2 under D129): recurring checklists as shipped product data, the
 * MWST-Periode first, the guided close on the same engine.
 *
 * A template instantiates into a run with dated, owned, evidenced items; the state is derived on
 * every read (live checks, probes, validations, hash-bound verb and preview evidence, append-only
 * sign-offs); eight `checklist_*` verbs, one MCP prompt per template and the G15 `checklist_items_due`
 * provider all read the ONE derivation in `runs.ts`. Nothing here posts, and no table carries a
 * `_rappen` column.
 */

export {
  CHECKLIST_CHECK_KEYS,
  CHECKLIST_EVIDENCE_KINDS,
  CHECKLIST_SIGNOFF_KINDS,
  CHECKLIST_PERIOD_KINDS,
  CHECKLIST_ANCHORS,
  CHECKLIST_DERIVE_KEYS,
  CHECKLIST_VERB_INPUT_KEYS,
  CHECKLIST_PROBE_KEYS,
  CHECKLIST_VALIDATION_KEYS,
  CHECKLIST_VALIDATION_SEVERITIES,
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
  ChecklistAnchor,
  ChecklistDeriveKey,
  ChecklistVerbInputKey,
  ChecklistProbeKey,
  ChecklistValidationKey,
  ChecklistValidationSeverity,
  ChecklistChoiceOption,
  ChecklistTemplateItem,
  ChecklistTemplate,
} from './types.js';
export {
  CHECKLIST_TEMPLATES,
  CHECKLIST_TEMPLATE_IDS,
  VAT_PERIOD_TEMPLATE,
  VAT_PERIOD_TEMPLATE_ID,
  MONTH_CLOSE_TEMPLATE,
  MONTH_CLOSE_TEMPLATE_ID,
  YEAR_CLOSE_TEMPLATE,
  YEAR_CLOSE_TEMPLATE_ID,
  YEAR_CLOSE_BLOCK_VALIDATIONS,
  YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF,
  GMBH_OR_AG,
  VAT_REGISTERED,
  LEGAL_FORM_OPTIONS,
  VAT_METHOD_OPTIONS,
  YES_NO,
  TEST_KINDS_TEMPLATE,
  TEST_KINDS_TEMPLATE_ID,
  checklistTemplate,
  checklistTemplates,
  listChecklistTemplates,
  testFixturesEnabled,
} from './canon/index.js';
export { CHECKLISTS_SCHEMA_SQL } from './schema.js';
export { DEADLINE_DAYS_AFTER_PERIOD_END, MONTHS_6, addDays, addMonths, dayBefore, endOfMonth, resolveDueDates } from './deadlines.js';
export {
  resolveChecklistPeriod,
  fiscalYearBounds,
  fiscalYearStartOf,
  monthBounds,
  monthsBetween,
  todayOf,
  yearSealedOf,
} from './periods.js';
export type { ChecklistPeriod } from './periods.js';
export { evaluateCheck, liveReturnOf, periodLockOf, lockOnMonth, lockOnYear, sealOnYear, yearLabelOf } from './checks.js';
export type { CheckResult, CheckPeriod, LiveReturn } from './checks.js';
export { returnHashOf, canonicalHashOf, canonicalize } from './hash.js';
export {
  VERB_EVIDENCE,
  liveAnchorOf,
  readMemoOf,
  statementsHashOf,
  verbEvidenceOf,
  verbInputValueOf,
  pointerIsEmpty,
} from './anchor.js';
export type { LiveAnchor, ReadMemo, VerbEvidence, VerbEvidenceFn } from './anchor.js';
export { evaluateProbe, NEEDS_A38 } from './probes.js';
export type { ProbeResult } from './probes.js';
export { evaluateValidation, PRIOR_YEAR_PCT_BAND, PRIOR_YEAR_MINOR_BAND, CAPITAL_LOSS_RATIO } from './validations.js';
export type { ValidationResult, ValidationOutcome } from './validations.js';
export {
  CHECKLIST_AUTOSTART_RULE_IDS,
  CHECKLIST_AUTOSTART_RULES,
  CHECKLIST_AUTOSTART_TRIGGER,
  NOT_AUTOMATABLE_TEMPLATE_IDS,
  TEMPLATE_NOT_AUTOMATABLE_CODE,
  seedDefaultChecklistRules,
  checklistAutostartRuleId,
  checklistAutostartTemplateOf,
} from './autostart.js';
export type { ChecklistAutostartRule } from './autostart.js';
export {
  CHECKLIST_RUN_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  CHECKLIST_DERIVED_ITEM_STATUSES,
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
  ChecklistDerivedItemStatus,
  ChecklistActorKind,
  ChecklistRunView,
  ChecklistItemView,
  ChecklistSignoffView,
  ChecklistPreviewView,
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
