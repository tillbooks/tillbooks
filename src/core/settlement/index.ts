/** D185, the settlement socket: the public surface of `src/core/settlement/`. */
export {
  SETTLEMENT_SCHEMA,
  SETTLEMENT_KINDS,
  SETTLEMENT_MAX_EVENTS,
  SETTLEMENT_EVENT_REFUSALS,
  parseExactMinor,
  isSettlementDay,
  normalizeSourceName,
  readSettlementDocument,
} from './format.js';
export type { SettlementKind, SettlementEvent, RefusedSettlementEvent, SettlementDocument } from './format.js';
export {
  TEMPLATE_ACTIONS,
  TEMPLATE_KIND_DEFAULTS,
  BOOKABLE_TAX_KINDS,
  setSettlementTemplate,
  prevalidateSetSettlementTemplate,
  getSettlementTemplate,
  readStoredTemplate,
} from './template.js';
export type { KindRule, SettlementTemplate, SetSettlementTemplateOk, GetSettlementTemplateOk } from './template.js';
export {
  importSettlement,
  prevalidateImportSettlement,
  SETTLEMENT_MAX_BYTES,
  SETTLEMENT_MAX_ATTACHMENTS,
  SETTLEMENT_ATTACHMENTS_MAX_BYTES,
  SETTLEMENT_OUTCOME_TEXT,
  outcomeDigestOf,
} from './importSettlement.js';
export type { ImportSettlementOk, ImportSettlementInput, ImportSettlementInternal, SettlementEventOutcome, KindTotals } from './importSettlement.js';
export { SETTLEMENT_SCHEMA_SQL } from './schema.js';
export {
  setSettlementSource,
  prevalidateSetSettlementSource,
  getSettlementSource,
  pullSettlement,
  prevalidatePullSettlement,
  recordFailedPull,
  dailyAttemptsOn,
  dailyRangeOf,
  listSourceRows,
  mintTokenRef,
  feedUrlOf,
  readBaseUrl,
  SETTLEMENT_FEED_PATH,
  SETTLEMENT_PULL_MAX_DAYS,
  SETTLEMENT_PULL_OVERLAP_DAYS,
  SETTLEMENT_PULL_MODES,
  SETTLEMENT_PULL_REFUSALS,
  pullModeOf,
  pullOverlapDaysOf,
} from './source.js';
export type { SetSettlementSourceOk, PullSettlementOk, SettlementPullMode } from './source.js';
export { settlementPayoutForBankLine, compositionOf, payoutsMatching, payoutReachedBank, PAYOUT_MATCH_DAYS } from './payoutLink.js';
export type { PayoutMatch, PayoutComposition, SettlementPayoutForBankLineOk } from './payoutLink.js';
export { settlementVatFindings, cancellingGroupsModeOf, SETTLEMENT_CHECK_REASONS } from './vatFindings.js';
export type { SettlementVatFindings, CheckItem, LinkedEntry, SettlementCheckReason, UnplaceableItem, AmendmentChange } from './vatFindings.js';
export { figureChanges, foldStated, restatementsOf, latestStatedOf } from './restated.js';
export type { StatedFigures, FigureChange } from './restated.js';
export {
  TRANSACTION_KEY_KINDS,
  TEST_FEE_KINDS,
  isTestEvent,
  flaggedTest,
  keyValuesOf,
  testEventsModeOf,
  testFeesModeOf,
  testSkips,
  loadTestIndex,
} from './flags.js';
export {
  resolveSettlementEvent,
  prevalidateResolveSettlementEvent,
  activeOverridesOf,
  RESOLUTION_REFUSALS,
  TEST_RESOLUTIONS,
  OVERRIDE_RESOLUTIONS,
  SETTLEMENT_RESOLUTIONS,
} from './resolution.js';
export type { ResolveSettlementEventOk, ResolveSettlementEventInput, TestResolution, OverrideResolution, SettlementResolution, ActiveOverride } from './resolution.js';
// A42, the Umsatz review.
export { handledOutsideOf, latestInclusionsOf } from './overrides.js';
export type { InclusionRow } from './overrides.js';
export { setSettlementEventIgnored, prevalidateSetSettlementEventIgnored, INCLUSION_REFUSALS, INCLUSION_REASON_MAX } from './inclusion.js';
export type { SetSettlementEventIgnoredOk, SetSettlementEventIgnoredInput } from './inclusion.js';
export { settlementReview, periodAround, periodPartOf, reviewPeriodOf, emailOf, REVIEW_PERIODS } from './review.js';
export type { SettlementReviewOk, SettlementReviewInput, ReviewRow, ReviewTotals, PayoutCheck } from './review.js';
// D203, the turnover from the books and the periods' booking state.
export { turnoverSummary, settlementPeriods, compareWindowOf, TURNOVER_COMPARE, TURNOVER_MAX_DAYS, TURNOVER_TOP_MAX } from './turnover.js';
export type { TurnoverSummaryOk, TurnoverSummaryInput, TurnoverFigures, TurnoverSourceFigure, TurnoverMonth, TurnoverCustomer, SettlementPeriodsOk, SettlementPeriodsInput, SettlementPeriod, SettlementPeriodState } from './turnover.js';
export { derivationOf } from './derivation.js';
export type { SettlementDerivation, PlatformFeeWaiverReason } from './derivation.js';
// A43 §2, the table door: a CSV or XLSX export to a till-settlement/v1 document, and its per-source mapping.
export { readTable, TABLE_MAX_BYTES, TABLE_MAX_ROWS } from './tabular.js';
export type { TableRead, TableContainer } from './tabular.js';
export {
  settlementFromTable,
  setSettlementTableMapping,
  prevalidateSetSettlementTableMapping,
  getSettlementTableMapping,
  readStoredTableMapping,
  readTableMapping,
  readImportProfile,
  tableToSettlement,
  guessMapping,
  settlementTableProfiles,
  profileForHeaders,
  profileOfMapping,
  decimalOf,
  TABLE_COLUMN_FIELDS,
  TABLE_VAT_MODES,
  TABLE_DATE_FORMATS,
  TABLE_ROW_REFUSALS,
  DAY_STATUSES,
  ID_SCHEME_VERSION,
  dayIdsOf,
  isWholeDayMapping,
} from './tableMapping.js';
export type { TableMapping, SettlementFromTableOk, SetSettlementTableMappingOk, GetSettlementTableMappingOk, RefusedRow, MappingSource, SettlementTableProfile, DayStatus, DayVerdictView } from './tableMapping.js';
export { heldVerdictOf, tableEventIdModeOf, tableEdgeDaysModeOf, TABLE_EVENT_ID_MODES, TABLE_EDGE_DAY_MODES, DAY_ID_PREFIX } from './dayMode.js';
export type { HeldVerdict, TableEventIdMode, TableEdgeDaysMode } from './dayMode.js';
export { IMPORT_PROFILE_SCHEMA, SETTLEMENT_TABLE_PROFILE_DATA, GENERIC_PROFILE_ID, PROFILE_NOTE } from './profiles.js';
