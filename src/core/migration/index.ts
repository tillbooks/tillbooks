/**
 * G10, migration maps and the locale seam: the barrel `src/api/` imports from.
 *
 * The `src/core/migration/` directory is the migration FAMILY's home (D88). G10 owns `maps.ts`,
 * `locale/` and the adapter-registry seam; the sibling capabilities own their own files here
 * (G09 `plan.ts` and the full adapter registry, G11 `check.ts`, G12 `testmandant.ts`,
 * G13 `archive.ts`) and extend this barrel when they land.
 */

export {
  MAP_KINDS,
  MAP_PROVENANCES,
  SUGGESTION_SOURCES,
  suggestMap,
  setMap,
  getMap,
  resolveTaxTarget,
  saveMapTemplate,
  listMapTemplates,
  applyMapTemplate,
} from './maps.js';
export type { MapKind, MapProvenance, SuggestionSource, MapEntry } from './maps.js';
export { MIGRATION_SCHEMA_SQL } from './schema.js';
export {
  LOCALE_PACKS,
  LOCALE_PACK_IDS,
  DEFAULT_LOCALE_PACK_ID,
  localePackDef,
  normalizeToken,
} from './locale/registry.js';
export type { LocalePack } from './locale/registry.js';
export { SOURCE_ADAPTERS, SOURCE_ADAPTER_IDS, sourceAdapterDef } from './adapters/registry.js';
export type { SourceAdapterDef } from './adapters/registry.js';

// --- G09 migration harness ----------------------------------------------------------------------
export {
  DATA_CLASSES,
  DATA_CLASS_IDS,
  DATA_CLASS_REGISTRY,
  dataClassDef,
  isDataClass,
} from './dataClasses.js';
export type { DataClass, DataClassDef } from './dataClasses.js';

export {
  PLAN_STATES,
  PLAN_PHASE,
  STEP_STATES,
  CONFLICT_OUTCOMES,
  discoverSource,
  createPlan,
  setScope,
  getPlan,
  listPlans,
  readiness,
  abandonPlan,
  closePlan,
} from './plan.js';
export type { PlanState, StepState, ConflictOutcome, PlanRow, StepRow } from './plan.js';

export {
  STEP_TRANSITIONS,
  previewStep,
  trialLoadStep,
  commitStep,
  rollbackStep,
  recordApproval,
} from './steps.js';

export {
  parseSource,
  parseGenericCsv,
  isParseFailure,
  parseStream,
  parseStreamSync,
  bytesAsChunks,
  bytesAsChunksSync,
  STREAM_BATCH_ROWS,
} from './adapters/parse.js';
export type { ParseResult, ParseFailure, ParsedRow, ParseBatch } from './adapters/parse.js';

// --- G11 Eröffnungsprüfung ----------------------------------------------------------------------
export {
  declareControlTotal,
  checkStepVerb,
  getCheck,
  listChecks,
  waiveControl,
  exportCheck,
  runCheck,
  seamCheckStep,
  controlStatusExcludesAmber,
} from './check.js';
export type { ControlSnapshotRow, RunCheckOutcome } from './check.js';
export {
  CONTROL_KINDS,
  CONTROL_STATUSES,
  CHECK_RUNS,
  CONTROL_REGISTRY,
  isControlKind,
  isControlStatus,
} from './controls/index.js';
export type {
  ControlKind,
  ControlStatusValue,
  CheckRun,
  ControlEnv,
  ControlFinding,
  ControlModule,
  SourceFileFact,
} from './controls/index.js';

// --- G12 Testmandant ----------------------------------------------------------------------------
export {
  WORKSPACE_KINDS,
  isWorkspaceKind,
  workspaceKindsAreExactlyThree,
  testmandantWorkspaceId,
  createTestmandant,
  getTestmandant,
  diffTestmandantToLive,
  goProductive,
  discardTestmandant,
  hardDeleteWorkspace,
} from './testmandant.js';
export type { WorkspaceKind } from './testmandant.js';

// --- G13 GL archive -----------------------------------------------------------------------------
export {
  PURGE_OUTCOMES,
  RETENTION_STATUTE,
  archivePreview,
  archiveImport,
  archiveQuery,
  archiveAccountHistory,
  archivePeriods,
  archivePurge,
  archiveComparative,
  retentionUntilFor,
  parseAmountMinor,
} from './archive.js';
export type { PurgeOutcome, ArchiveComparativeInput, ArchiveComparativeAccount } from './archive.js';
export { GL_ARCHIVE_SCHEMA_SQL } from './archiveSchema.js';

// --- G19 extraction companion (guides + export-completeness manifest) ----------------------------
export {
  MANIFEST_ITEM_STATUSES,
  isManifestItemStatus,
  listExtractionGuides,
  getExtractionGuide,
  setManifest,
  setManifestItem,
  getManifest,
  deadlineOf,
} from './manifest.js';
export type { ManifestItemStatus, ManifestItemEntry, Completeness } from './manifest.js';
export {
  EXTRACTION_GUIDES,
  EXTRACTION_GUIDE_IDS,
  extractionGuideDef,
  resolveGuide,
  genericGuide,
  guideHasCompanion,
} from './guides/registry.js';
export { RUNGS, guideItemIsWellFormed } from './guides/types.js';
export type { ExtractionGuide, GuideItem, Rung, LetterTemplate } from './guides/types.js';
export { DATENHERAUSGABE_LETTER } from './guides/letter.js';
export { EXTRACTION_MANIFEST_SCHEMA_SQL } from './manifestSchema.js';

// --- G20 implementation projects (project object, runbooks, parallel-run reconciliation, roster) --
export {
  PHASES,
  ABANDONED,
  TASK_STATUSES,
  OWNER_KINDS,
  SIGNOFF_KINDS,
  isPhase,
  isTaskStatus,
  isOwnerKind,
  isSignoffKind,
  actorIsHuman,
  reconciliationEvidenceHash,
  projectCreate,
  projectGet,
  projectList,
  projectInstantiateRunbook,
  projectSetTask,
  projectRecordDecision,
  projectRecordSignoff,
  declareParallelFigures,
  getParallelStatus,
  runParallelCheckVerb,
  projectClose,
} from './project.js';
export type { Phase, TaskStatus, OwnerKind, SignoffKind } from './project.js';
export {
  MWST_METHODS,
  isMwstMethod,
  FIGURE_KINDS,
  isFigureKind,
  FIGURE_STATUSES,
  parallelRunPassed,
} from './parallelRun.js';
export type { MwstMethod, FigureKind, FigureStatus, DeclaredFigure, CheckedFigure } from './parallelRun.js';
export {
  RUNBOOK_TEMPLATES,
  RUNBOOK_TEMPLATE_IDS,
  runbookTemplate,
  listRunbookTemplates,
} from './runbooks/registry.js';
export type { RunbookTemplate, RunbookTemplateItem, RunbookPhase, RunbookOwnerKind, DeadlineRule } from './runbooks/registry.js';
export { IMPLEMENTATION_PROJECT_SCHEMA_SQL } from './projectSchema.js';

// --- G21 open-items AR/AP migration (the origin='migrated' carry-forward, posts nothing) ----------
export { importOpenItems, previewOpenItems } from './openItems.js';
export { isCutoverPending, cutoverInFuture } from './stichtag.js';
export type {
  ImportOpenItemsInput,
  PreviewOpenItemsInput,
  OpenItemArRow,
  OpenItemApRow,
  OpenItemLineInput,
} from './openItems.js';
