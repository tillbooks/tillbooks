/**
 * The H-cluster (fixed assets) engine barrel. H00 lands the category master; H01+ extend it.
 */

export {
  DEPRECIATION_METHODS,
  createAssetCategory,
  updateAssetCategory,
  archiveAssetCategory,
  listAssetCategories,
  getAssetCategory,
  resolveAssetCategoryDefaults,
} from './category.js';
export type {
  DepreciationMethod,
  CreateAssetCategoryInput,
  UpdateAssetCategoryInput,
  ListAssetCategoriesInput,
} from './category.js';
export { ASSETS_SCHEMA_SQL } from './schema.js';

// H01, the Asset Master: the controlled record every asset is, extending the H00 category root.
export {
  ASSET_STATUSES,
  createAsset,
  updateAsset,
  getAsset,
  listAsset,
  searchAsset,
  archiveAsset,
} from './master.js';
export type { AssetStatus, CreateAssetInput, UpdateAssetInput, ListAssetInput } from './master.js';
export { ASSET_MASTER_SCHEMA_SQL } from './masterSchema.js';

// H03, the depreciation methods & engine: pure calculators (OP12) + the four preview/schedule/methods
// verbs. Computes FROM the H01 asset master's fields; posts nothing (H04 posts).
export {
  calculateDepreciation,
  calculateDepreciationBatch,
  projectDepreciationSchedule,
  registerDepreciationMethod,
  hasDepreciationMethod,
  registeredMethods,
  listDepreciationMethods,
  setMethodEnabled,
  previewDepreciation,
  scheduleDepreciation,
  isPeriod,
  nextPeriod,
  daysInPeriod,
  DEPRECIATION_SCHEMA_SQL,
} from './depreciation/index.js';
export type {
  AssetSnapshot,
  CalcContext,
  DepreciationResult,
  ScheduleLine,
  MethodDescriptor,
  ProRataConvention,
  SetMethodEnabledInput,
  PreviewInput,
  ScheduleInput,
} from './depreciation/index.js';
// H02, Asset Acquisition: the first financial event, the dual-write (asset_transaction + A02 journal)
// that capitalises a draft asset, plus the two sub-ledger reads.
export {
  assetAcquire,
  assetAddCapitalisation,
  assetTransactionList,
  assetTransactionGet,
} from './acquisition.js';
export type { AssetAcquireInput, AssetAddCapitalisationInput } from './acquisition.js';
export { ASSET_TRANSACTION_SCHEMA_SQL } from './transactionSchema.js';

// H05, Asset Transfer & Location: the workspace location master + the non-posting transfer that moves
// assets between locations/custodians, recording an append-only history row per asset. Posts nothing.
export {
  createAssetLocation,
  updateAssetLocation,
  archiveAssetLocation,
  listAssetLocation,
  getAssetLocation,
  assetTransfer,
  assetTransferHistory,
} from './transfer.js';
export type {
  CreateAssetLocationInput,
  UpdateAssetLocationInput,
  ListAssetLocationInput,
  AssetTransferInput,
} from './transfer.js';
export { ASSET_TRANSFER_SCHEMA_SQL } from './transferSchema.js';
// H04, Depreciation Run & Posting: the period-end process that turns H03's calculated amounts into a
// balanced A02 journal + append-only asset_transaction rows, and reverses them without rewriting history.
export {
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDepreciationRunReverse,
  assetDepreciationRunGet,
  assetDepreciationRunList,
} from './depreciationRun.js';
export type {
  RunCreateInput,
  RunPostInput,
  RunReverseInput,
  RunListInput,
} from './depreciationRun.js';
export { DEPRECIATION_RUN_SCHEMA_SQL } from './depreciationRunSchema.js';

// H06, Asset Disposal: the TERMINAL financial event. The dual-write (a balanced A02 disposal journal
// clearing cost + accumulated depreciation and recognising the book gain/loss, an append-only
// asset_transaction of type=disposal, and the asset moved to status=disposed) plus a pure preview and
// a disposal-scoped read. Writes only through A02; extends the H02 asset_transaction table, never its DDL.
export { assetDispose, assetDisposalPreview, assetDisposalGet } from './disposal.js';
export type { AssetDisposeInput, AssetDisposalPreviewInput, AssetDisposalInputBase } from './disposal.js';

// H07, Asset Ledger & Reconciliation: the READ half (the per-asset ledger with running balances and the
// cross-asset event list) + the OP11 reconciliation (sub-ledger vs GL control accounts, on demand and as
// the hard period-close check) + the one opening-balance write. Derived from the append-only
// asset_transaction table; posts only through A02.
export { assetLedgerGet, assetLedgerList, assetOpeningBalance } from './ledger.js';
export type { AssetLedgerListInput, AssetOpeningBalanceInput } from './ledger.js';
export { assetReconciliationReport, assetReconciliationCheck } from './reconciliation.js';
export type { ReconciliationReportInput, ReconciliationCheckInput } from './reconciliation.js';
// H08, Simple Maintenance Log: an append-oriented, workspace-scoped log of completed (or cancelled)
// maintenance events on an asset, with optional DESCRIPTIVE cost capture. Posts NOTHING to the GL (the
// captured cost is TCO metadata for H09); a row is updated/cancelled but never hard-deleted.
export {
  MAINTENANCE_TYPES,
  assetMaintenanceLogCreate,
  assetMaintenanceLogUpdate,
  assetMaintenanceLogCancel,
  assetMaintenanceLogGet,
  assetMaintenanceLogList,
} from './maintenance.js';
export type {
  CreateMaintenanceLogInput,
  UpdateMaintenanceLogInput,
  CancelMaintenanceLogInput,
  ListMaintenanceLogInput,
} from './maintenance.js';
export { MAINTENANCE_SCHEMA_SQL } from './maintenanceSchema.js';

// H09, Asset Reports & Agent Tools: the READ-ONLY report surface over the H00-H08 cluster. Six new pure
// report verbs; reconciliation (H07) and per-asset transaction history (H07 ledger) are re-used, not
// re-minted. Posts nothing, creates no table (P5 read-model purity).
export {
  assetRegisterReport,
  assetDepreciationForecast,
  assetDisposalSummary,
  assetAcquisitionSummary,
  assetNbvSummary,
  assetEndOfLifeList,
} from './reports.js';
export type {
  AssetRegisterFilter,
  AssetRegisterReportInput,
  AssetDepreciationForecastInput,
  AssetDisposalSummaryInput,
  AssetAcquisitionSummaryInput,
  AssetNbvSummaryInput,
  AssetEndOfLifeInput,
} from './reports.js';
