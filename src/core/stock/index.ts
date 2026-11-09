/**
 * D01, inventory / stock: the barrel `src/api/` imports from. Builds the OP2 stock seam D03 later
 * consumes: locations, the non-posting movement ledger, on-hand and low-stock read models, the
 * period-end A02 valuation, and the Inventur state machine.
 */

export { upsertStockLocation, listStockLocations } from './locations.js';
export type { UpsertLocationInput, StockLocation } from './locations.js';
export { recordStockMove, stockOnHand, lowStockList, insertMovement } from './movements.js';
export type { StockMoveInput, MovementRow } from './movements.js';
export { runValuation, valuationReport, computeInventoryValue } from './valuation.js';
export type { RunValuationInput, ValuationReportInput, ItemValue } from './valuation.js';
export { stocktakeOpen, stocktakeCount, stocktakeReport, stocktakeCommit } from './stocktake.js';
export type { StocktakeOpenInput, StocktakeCountInput, StocktakeCommitInput } from './stocktake.js';
export { STOCK_REASONS, VALUATION_METHODS, STOCKTAKE_STATUSES, isStockReason, isValuationMethod, isStocktakeStatus } from './enums.js';
export type { StockReason, ValuationMethod, StocktakeStatus } from './enums.js';
export { STOCK_SCHEMA_SQL } from './schema.js';
