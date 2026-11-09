/**
 * J00 warehouses & locations: the Wave-13 inventory ROOT engine barrel. The `src/api/` layer imports
 * from here. J01 (lot/serial) and J02 (movement ledger) attach to this seam: locations live on the
 * extended `stock_location` table, warehouses on the `warehouse` table, and on-hand is always the SUM
 * over the OP2 movement ledger.
 */

export {
  warehouseCreate,
  warehouseUpdate,
  warehouseSetDefault,
  warehouseArchive,
  warehouseList,
  warehouseGet,
} from './warehouse.js';
export type { CreateWarehouseInput, UpdateWarehouseInput, ListWarehousesInput } from './warehouse.js';

export {
  locationCreate,
  locationUpdate,
  locationSetDefault,
  locationArchive,
  locationList,
  locationGet,
  locationTree,
} from './location.js';
export type { CreateLocationInput, UpdateLocationInput, ListLocationsInput } from './location.js';

export { inventoryBalanceByLocation, inventoryEnsureDefaultLocation } from './balance.js';
export type { BalanceFilter } from './balance.js';

export {
  ensureDefaultLocation,
  resolveDefaultLocationId,
  resolveDefaultPair,
  resolveOrCreateDefaultLocationId,
} from './defaults.js';
export type { DefaultPair } from './defaults.js';

export { LOCATION_TYPES, isLocationType, mapWarehouse, mapLocation } from './types.js';
export type { LocationType, Warehouse, Location } from './types.js';

export { INVENTORY_SCHEMA_SQL } from './schema.js';

// J01 lot & serial tracking: the two master tables plus the on-hand-by-lot / available-serials read
// models attach to this same inventory seam (spec §4).
export {
  itemSetTrackingMode,
  lotCreate,
  lotUpdate,
  lotSetStatus,
  lotArchive,
  lotGet,
  lotList,
  lotSearch,
  serialCreate,
  serialCreateBulk,
  serialUpdate,
  serialSetStatus,
  serialArchive,
  serialGet,
  serialList,
  serialSearch,
  inventoryOnHandByLot,
  inventoryAvailableSerials,
  TRACKING_MODES,
  LOT_STATUSES,
  SERIAL_STATUSES,
} from './tracking.js';
export type { TrackingMode, LotStatus, SerialStatus, Lot, Serial } from './tracking.js';

export { TRACKING_SCHEMA_SQL } from './trackingSchema.js';

// J02 the movement ledger: D01's stock_movement becomes the authoritative append-only ledger. This
// module owns the ONE write path (inventoryMove + the inventoryTransfer pair), the pure balance /
// movement read models (on-hand is always SUM(stock_movement.qty), never a stored column), the
// tracking enforcement (lot_required / serial_required) and the negative-stock policy config.
export {
  inventoryMove,
  inventoryTransfer,
  inventoryBalance,
  inventoryMovementList,
  inventoryMovementGet,
  inventoryGetConfig,
  inventorySetConfig,
  allowNegativeStock,
  MOVEMENT_TYPES,
  isMovementType,
} from './movement.js';
export type {
  MovementType,
  InventoryMovement,
  InventoryMoveInput,
  InventoryTransferInput,
  InventoryBalanceInput,
  InventoryMovementListInput,
  SetConfigInput,
} from './movement.js';

export { MOVEMENT_SCHEMA_SQL } from './movementSchema.js';

// J03 valuation: the PURE calculators (no ctx, no database, no clock) and the policy layer over them.
// The dated append-only method assignment is what makes OR 958c Stetigkeit demonstrable and what the
// §H-PERIOD guard is checked against; J03 posts nothing, J06 takes these numbers to A02.
export {
  VALUATION_METHODS,
  DEFAULT_ENABLED_METHODS,
  BUILTIN_DEFAULT_METHOD,
  isValuationMethod,
  normaliseMethod,
  requiresStandardCost,
  commercialRound,
  buildFifoLayers,
  calculateItemValue,
  calculateValuationBatch,
} from './valuation.js';
export type {
  ValuationMethod,
  MovementLine,
  ItemSnapshot,
  CostLayer,
  ValuationContext,
  ValuationResult,
} from './valuation.js';

export {
  enabledMethods,
  resolveMethodAt,
  inventoryValuationMethods,
  inventoryValuationPreview,
  inventoryValuationLayers,
  inventoryValuationMethodHistory,
  inventoryValuationMethodSetEnabled,
  inventoryValuationSetDefault,
  inventoryValuationSetItemMethod,
  itemBookValueMinor,
} from './valuationPolicy.js';
export type {
  ResolvedMethod,
  PreviewInput,
  LayersInput,
  MethodHistoryInput,
  SetEnabledInput,
  SetDefaultInput,
  SetItemMethodInput,
} from './valuationPolicy.js';

export { VALUATION_SCHEMA_SQL } from './valuationSchema.js';

// J06 valuation run & GL link (OP11 for inventory): the ONLY path an inventory valuation figure
// reaches the General Ledger, and it reaches it through A02 `postEntry` / `reverseEntry`. Owns the
// `inventory_valuation_run` / `_line` tables and the reconciliation that proves sub-ledger == GL.
export {
  inventoryValuationCreate,
  inventoryValuationPost,
  inventoryValuationReverse,
  inventoryValuationOpening,
  inventoryValuationGet,
  inventoryValuationList,
  inventoryValuationReport,
  inventoryReconciliationReport,
  inventoryReconciliationCheck,
} from './reconciliation.js';
export type {
  ValuationCreateInput,
  ValuationPostInput,
  ValuationReverseInput,
  ValuationOpeningInput,
  ValuationListInput,
  ValuationReportInput,
  ReconciliationReportInput,
} from './reconciliation.js';

export { RECONCILIATION_SCHEMA_SQL } from './reconciliationSchema.js';

// J04 cycle count / stocktake: a scoped stocktake session that freezes a J02 balance-as-of snapshot,
// accepts counts (blind or open), surfaces variance against thresholds, and commits every non-zero
// variance EXCLUSIVELY as an OP13 / J02 `inventoryMove` (movement_type `adjustment`). It owns its own
// session / line tables (`cycle_count_session`, `cycle_count_line`) and NEVER writes a quantity, so
// on-hand stays SUM(stock_movement.qty). D01's live `stocktake_session` stays queryable read-through.
export {
  inventoryStocktakeCreate,
  inventoryStocktakeCount,
  inventoryStocktakeReport,
  inventoryStocktakeApproveLines,
  inventoryStocktakeRequestRecount,
  inventoryStocktakeCommit,
  inventoryStocktakeCancel,
  inventoryStocktakeGet,
  inventoryStocktakeList,
  STOCKTAKE_SESSION_TYPES,
  STOCKTAKE_SESSION_STATUSES,
  STOCKTAKE_LINE_STATUSES,
} from './stocktake.js';
export type {
  StocktakeSessionType,
  StocktakeSessionStatus,
  StocktakeLineStatus,
  StocktakeCreateInput,
  StocktakeCountInput,
  StocktakeApproveInput,
  StocktakeRecountInput,
  StocktakeCommitInput,
  StocktakeCancelInput,
  StocktakeListInput,
} from './stocktake.js';

export { STOCKTAKE_SCHEMA_SQL } from './stocktakeSchema.js';

// J05 inventory adjustments & reasons: the workspace-scoped reason-code catalog plus the reason-coded
// MANUAL adjustment facade over J02's `inventoryMove` (movement_type `adjustment`). It owns its own
// `inventory_reason_code` + `inventory_adjustment` tables and writes NO quantity of its own; the reason
// linkage lives on the append-only `inventory_adjustment` row, enforced at the J05 verb (NOT at the J02
// insert, which stays reason-agnostic for J04 stocktake). Reverse is a NEW linked row, never an edit.
export {
  inventoryReasonCreate,
  inventoryReasonUpdate,
  inventoryReasonArchive,
  inventoryReasonList,
  inventoryReasonGet,
  readReason,
  hasActiveReason,
  REASON_CATEGORIES,
  isReasonCategory,
} from './reason.js';
export type {
  ReasonCategory,
  InventoryReasonCode,
  ReasonCreateInput,
  ReasonUpdateInput,
  ReasonArchiveInput,
  ReasonListInput,
} from './reason.js';

export {
  inventoryAdjust,
  inventoryAdjustBatch,
  inventoryAdjustReverse,
  inventoryAdjustList,
  inventoryAdjustAnalysis,
} from './adjust.js';
export type {
  InventoryAdjustment,
  AdjustInput,
  AdjustBatchLine,
  AdjustBatchInput,
  AdjustReverseInput,
  AdjustListInput,
  AdjustAnalysisInput,
} from './adjust.js';

export { ADJUST_SCHEMA_SQL } from './adjustSchema.js';

// J07 inventory agent tools & alerts: the TERMINAL inventory leaf. Ten pure, read-only agent verbs
// over the whole J00-J06 cluster (stock position, low stock, alerts, movement history, valuation
// status, lot trace, anomalies, slow movers, cycle-count status, reorder candidates). Owns no table
// and posts nothing (P5, §H-STOCK-AUDIT); every figure is derived from the append-only J02 ledger and
// the J03/J06 valuation reads on the spot. §H-TENANT on every query.
export {
  inventoryStockPosition,
  inventoryLowStock,
  inventoryValuationStatus,
  inventoryMovementHistory,
  inventoryAnomalies,
  inventoryCycleCountStatus,
  inventoryLotTrace,
  inventorySlowMovers,
  inventoryAlerts,
  inventoryReorderCandidates,
  AGENT_DEFAULT_THRESHOLDS,
  ANOMALY_TYPES,
} from './agent.js';
export type {
  AgentThresholds,
  AnomalyType,
  StockPositionInput,
  LowStockInput,
  ReorderCandidatesInput,
  ValuationStatusInput,
  MovementHistoryInput,
  LotTraceInput,
  SlowMoversInput,
  AnomaliesInput,
  AlertsInput,
  CycleCountStatusInput,
} from './agent.js';
